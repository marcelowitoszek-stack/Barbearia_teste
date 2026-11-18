import { config } from "./config";
import { responder } from "./agent";
import { normalizar } from "./catalogo";
import { estadoDe, iniciarSessao } from "./sessao";

/**
 * Fluxo da conversa ANTES e EM VOLTA da IA. Nao sabe nada de WhatsApp: devolve o
 * que enviar e o que fazer depois. O webhook e o simulador do painel usam este
 * mesmo codigo, entao o teste no painel e fiel ao que o cliente ve.
 */

export type Acao =
  /** Opcao 3: avisar o barbeiro, encerrar a sessao e silenciar o atendente. */
  | "humano"
  /** Cliente disse que nao precisa de mais nada: despedida enviada, fecha se ficar quieto. */
  | "despedida"
  /** Reserva feita: armar o encerramento por inatividade. */
  | "posReserva";

export interface Resultado {
  mensagens: string[];
  /** true = a resposta veio da IA (pode ser descartada se o cliente complementou). */
  ia: boolean;
  acao?: Acao;
}

/**
 * Le a escolha do menu. So aceita resposta curta e inequivoca: "2", "2.", "opcao 3",
 * "dois", "humano"... Uma frase longa com um numero no meio ("quero 2 cortes")
 * NAO conta como escolha.
 */
export function lerOpcao(texto: string): 2 | 3 | undefined {
  const t = normalizar(texto);
  if (!t || t.length > 30) return undefined;
  if (/\b(humano|humanizado|atendente|pessoa|gente de verdade)\b/.test(t)) return 3;
  if (/\bvirtual\b/.test(t)) return 2;
  // Tira as palavras de enchimento; o que sobrar tem que ser SO o numero.
  const limpo = t
    .replace(/\b(opcao|numero|num|quero|escolho|a|o|e|ok|por favor|pfv|pf)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (limpo === "2" || limpo === "dois") return 2;
  if (limpo === "3" || limpo === "tres") return 3;
  return undefined;
}

export async function conduzir(chatid: string, texto: string, nomeContato?: string): Promise<Resultado> {
  const estado = estadoDe(chatid);

  // 1. Primeira mensagem da sessao: boas-vindas fixas com as opcoes.
  if (!estado) {
    iniciarSessao(chatid, texto);
    return { mensagens: [config.mensagemBoasVindas], ia: false };
  }

  // 2. Aguardando a escolha 2 ou 3.
  if (estado.fase === "menu") {
    const opcao = lerOpcao(texto);
    if (opcao === 3) return { mensagens: [config.mensagemHumano], ia: false, acao: "humano" };
    if (opcao !== 2) {
      estado.pendente.push(texto); // a IA vai ver isso se ele escolher 2 depois
      return { mensagens: [config.mensagemOpcaoInvalida], ia: false };
    }
    estado.fase = "ia";
    const antes = estado.pendente.join("\n").trim();
    const entrada =
      `[O cliente leu a mensagem de boas-vindas e escolheu o atendimento virtual (opcao 2). ` +
      `O que ele tinha escrito antes do menu: "${antes}"]`;
    return comAcao(chatid, await responder(chatid, entrada, nomeContato));
  }

  // 3. Atendimento virtual em andamento.
  return comAcao(chatid, await responder(chatid, texto, nomeContato));
}

function comAcao(chatid: string, resposta: string): Resultado {
  const e = estadoDe(chatid);
  if (e?.encerrar) {
    // Despedida fixa no lugar do texto da IA. A marca vale so para este turno:
    // se o cliente escrever de novo dentro do prazo, o atendimento continua.
    e.encerrar = false;
    return { mensagens: [config.mensagemDespedida], ia: true, acao: "despedida" };
  }
  return { mensagens: [resposta], ia: true, acao: e?.posReserva ? "posReserva" : undefined };
}
