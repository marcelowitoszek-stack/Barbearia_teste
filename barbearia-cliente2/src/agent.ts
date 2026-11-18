import { GoogleGenAI, type Content } from "@google/genai";
import { assertGemini, config } from "./config";
import { buildSystemPrompt } from "./prompt";
import { declaracoes, esquecerCobranca } from "./tools";
import { apagarEstado } from "./sessao";
import { esquecerLead } from "./catalogo";
import { executarTool } from "./tool-runner";

/**
 * Cliente criado sob demanda: a chave pode ser trocada pelo painel com o
 * sistema rodando, e o proximo turno ja usa a nova.
 */
let cliente: { chave: string; ai: GoogleGenAI } | undefined;

function gemini(): GoogleGenAI {
  assertGemini();
  if (!cliente || cliente.chave !== config.geminiApiKey) {
    cliente = { chave: config.geminiApiKey, ai: new GoogleGenAI({ apiKey: config.geminiApiKey }) };
  }
  return cliente.ai;
}

/**
 * Tenta de novo quando o Gemini esta sobrecarregado (503 "high demand"), com
 * limite de taxa (429) ou com erro interno (500). Sao falhas passageiras: sem
 * isso o cliente fica sem resposta por um pico de uso do Google.
 */
async function comRetentativa<T>(fn: () => Promise<T>): Promise<T> {
  const esperas = [2_000, 5_000, 10_000];
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const passageiro = /\b(429|500|502|503|504)\b|high demand|overloaded|UNAVAILABLE|RESOURCE_EXHAUSTED/i.test(msg);
      if (!passageiro || i >= esperas.length) throw e;
      console.warn(`[agent] Gemini indisponivel, tentando de novo em ${esperas[i]! / 1000}s (${msg.slice(0, 80)})`);
      await new Promise((r) => setTimeout(r, esperas[i]));
    }
  }
}

/**
 * Transcreve audio do cliente. No Brasil metade do WhatsApp e audio -- ignorar
 * seria perder o cliente. O texto transcrito entra no historico como fala normal,
 * entao o historico continua leve (sem bytes de audio).
 */
export async function transcreverAudio(base64: string, mimeType: string): Promise<string> {
  const r = await gemini().models.generateContent({
    model: config.geminiModel,
    contents: [
      {
        role: "user",
        parts: [
          { inlineData: { data: base64, mimeType: mimeType.split(";")[0] || "audio/ogg" } },
          {
            text:
              "Transcreva este audio de WhatsApp em portugues, exatamente como foi falado. " +
              "Responda so com a transcricao, sem comentarios. Se nao houver fala, responda: [audio sem fala]",
          },
        ],
      },
    ],
    config: { temperature: 0, maxOutputTokens: 600 },
  });
  return (r.text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Historico em memoria
//
// Sem banco: Map<chatid, Content[]>. Reinicio do servidor zera as conversas --
// aceitavel para pre-atendimento, onde o lead ja foi logado no fechamento.
// ---------------------------------------------------------------------------

interface Sessao {
  historico: Content[];
  ultimoAcesso: number;
}

const sessoes = new Map<string, Sessao>();

function pegarSessao(chatid: string): Sessao {
  let s = sessoes.get(chatid);
  if (!s) {
    s = { historico: [], ultimoAcesso: Date.now() };
    sessoes.set(chatid, s);
  }
  s.ultimoAcesso = Date.now();
  return s;
}

/**
 * Corta o historico mantendo pares coerentes.
 *
 * CICATRIZ: um Content de functionResponse orfao (sem o functionCall que o
 * originou) faz o Gemini rejeitar a requisicao inteira -- por isso o corte
 * avanca ate a proxima fala do cliente em vez de fatiar no meio de uma rodada
 * de tools. Um slice(-24) ingenuo quebra toda conversa longa.
 */
function podar(historico: Content[]): Content[] {
  if (historico.length <= config.maxHistorico) return historico;

  // Os resultados de tool tambem entram como role "user", entao parar no primeiro
  // "user" nao basta: cair num turno de functionResponse deixaria a resposta sem o
  // functionCall que a originou, e a API rejeita esse par quebrado. So serve como
  // inicio um turno de fala real do cliente.
  const falaDoCliente = (c: Content | undefined): boolean =>
    c?.role === "user" && !c.parts?.some((p) => p.functionResponse);

  let inicio = historico.length - config.maxHistorico;
  while (inicio < historico.length && !falaDoCliente(historico[inicio])) inicio++;
  return inicio >= historico.length ? [] : historico.slice(inicio);
}

/** Descarta conversas ociosas para o Map nao crescer sem limite. */
export function limparSessoesOciosas(): number {
  const limite = Date.now() - config.sessaoTtlMs;
  let n = 0;
  for (const [chatid, s] of sessoes) {
    if (s.ultimoAcesso < limite) {
      sessoes.delete(chatid);
      esquecerLead(chatid); // senao o Map de leads cresce sem limite junto
      esquecerCobranca(chatid);
      n++;
    }
  }
  if (n > 0) console.log(`[agent] ${n} sessao(oes) ociosa(s) descartada(s)`);
  return n;
}

export function totalSessoes(): number {
  return sessoes.size;
}

/**
 * Encerra a sessao por completo: historico, pedido em andamento e fase do fluxo.
 * A proxima mensagem desse cliente comeca do zero, com as boas-vindas.
 */
export function resetarSessao(chatid: string): void {
  sessoes.delete(chatid);
  esquecerLead(chatid);
  esquecerCobranca(chatid);
  apagarEstado(chatid);
}

/**
 * Tira a formatacao de documento que o modelo as vezes deixa passar.
 *
 * Linha em branco no meio de uma mensagem de 2 frases faz parecer e-mail, nao
 * WhatsApp -- e o prompt sozinho nao segura isso de forma confiavel. Guardrail
 * mecanico na saida, porque instrucao falha de vez em quando e isto aqui nao.
 */
function limpar(texto: string): string {
  const t = texto.replace(/\r\n/g, "\n");
  // Lista de servicos (pedida pelo cliente): mantem uma linha por item.
  const ehLista = t.split("\n").filter((l) => l.trim()).length >= 3;
  return t
    .replace(/\n{2,}/g, ehLista ? "\n" : " ") // paragrafo vira continuacao da frase
    .replace(/^\s*[-*]\s+/gm, "") // marcador de lista que escapou
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/** Tamanho atual do historico -- marcador para desfazer o turno se ele nascer velho. */
export function marcarHistorico(chatid: string): number {
  return sessoes.get(chatid)?.historico.length ?? 0;
}

/**
 * Descarta tudo que entrou no historico depois do marcador.
 *
 * Usado quando o cliente manda mensagem nova enquanto o agente pensava: a resposta
 * pronta ja esta velha, entao o turno inteiro (fala do cliente, tools e resposta)
 * some e o proximo turno reprocessa com o contexto completo.
 */
export function desfazerTurno(chatid: string, marcador: number): void {
  const s = sessoes.get(chatid);
  if (s && s.historico.length > marcador) s.historico.length = marcador;
}

// ---------------------------------------------------------------------------
// Loop de conversa
// ---------------------------------------------------------------------------

/**
 * Processa um turno e devolve o texto a enviar.
 * `nomeContato` e o pushname do WhatsApp -- ajuda o agente a nao perguntar o nome a toa.
 */
export async function responder(
  chatid: string,
  texto: string,
  nomeContato?: string
): Promise<string> {
  const sessao = pegarSessao(chatid);
  // Reconstruido a cada turno: o prompt carrega a data de hoje. Montado uma vez no
  // boot, um processo que roda dias acha que ainda e o dia do deploy.
  const systemInstruction = buildSystemPrompt();

  // Contexto do nome so na primeira mensagem, para nao poluir todo turno.
  const primeira = sessao.historico.length === 0;
  const entrada =
    primeira && nomeContato?.trim()
      ? `[contato salvo no WhatsApp como "${nomeContato.trim()}"]\n${texto}`
      : texto;

  sessao.historico.push({ role: "user", parts: [{ text: entrada }] });

  for (let i = 0; i < config.maxToolIteracoes; i++) {
    const resposta = await comRetentativa(() => gemini().models.generateContent({
      model: config.geminiModel,
      contents: sessao.historico,
      config: {
        systemInstruction,
        tools: [{ functionDeclarations: declaracoes() }],
        // O loop de tools e nosso. Sem isso a AFC do SDK executa por fora e
        // o historico local sai dessincronizado do que o modelo realmente viu.
        automaticFunctionCalling: { disable: true },
        temperature: config.temperatura,
        maxOutputTokens: config.maxOutputTokens,
      },
    }));

    const chamadas = resposta.functionCalls ?? [];

    // Sem tools: e a resposta final.
    if (chamadas.length === 0) {
      const texto = limpar(resposta.text ?? "");
      if (!texto) break;
      // Mesmo motivo do bloco abaixo: preserva o content original quando existir.
      const turnoFinal = resposta.candidates?.[0]?.content;
      sessao.historico.push(
        turnoFinal?.parts?.length ? turnoFinal : { role: "model", parts: [{ text: texto }] }
      );
      sessao.historico = podar(sessao.historico);
      return texto;
    }

    // CICATRIZ: devolve o turno do modelo EXATAMENTE como veio, sem reconstruir.
    //
    // Os modelos Gemini 3.x anexam um `thoughtSignature` (base64 opaco) nas parts
    // de functionCall e exigem esse mesmo campo de volta na proxima requisicao.
    // Remontar as parts a partir de `resposta.functionCalls` descarta a assinatura
    // e a API responde 400: "Function call is missing a thought_signature".
    // Reaproveitar o content original preserva assinatura e parts de raciocinio.
    const turnoModelo = resposta.candidates?.[0]?.content;
    sessao.historico.push(
      turnoModelo?.parts?.length
        ? turnoModelo
        : {
            // Fallback para modelos que nao devolvem candidates (2.x e anteriores).
            role: "model",
            parts: chamadas.map((c) => ({
              functionCall: { name: c.name ?? "", args: c.args ?? {} },
            })),
          }
    );

    // Executa e devolve os resultados na mesma ordem.
    // Em sequencia, nao em paralelo: consultar a agenda e registrar no mesmo
    // turno precisam acontecer nessa ordem.
    const resultados = [];
    for (const c of chamadas) {
      const nome = c.name ?? "";
      const args = (c.args ?? {}) as Record<string, unknown>;
      console.log(`[agent] tool ${nome}(${JSON.stringify(args)})`);
      const saida = await executarTool(nome, args, chatid);
      resultados.push({ functionResponse: { name: nome, response: saida as Record<string, unknown> } });
    }

    sessao.historico.push({ role: "user", parts: resultados });
  }

  // Estourou o teto de iteracoes ou veio resposta vazia.
  console.warn(`[agent] turno sem resposta util para ${chatid}`);
  sessao.historico = podar(sessao.historico);
  return config.fraseFallback;
}
