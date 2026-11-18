import { timingSafeEqual } from "node:crypto";
import * as path from "node:path";
import express from "express";
import { config, configuracoesPublicas, minutos, salvarConfiguracoes } from "./config";
import { conduzir, type Acao } from "./fluxo";
import { limparEstadosOciosos } from "./sessao";
import {
  desfazerTurno,
  limparSessoesOciosas,
  marcarHistorico,
  resetarSessao,
  totalSessoes,
  transcreverAudio,
} from "./agent";
import {
  baixarMidia,
  desconectar,
  enviarTexto,
  estadoConexao,
  evolutionOnline,
  foiOAgente,
  gerarCodigoPareamento,
  gerarQrCode,
  marcarComoLida,
  perfilConectado,
  listarContatos,
  listarEtiquetas,
  prepararInstancia,
} from "./evolution";
import { estaPausado, limparPausasVencidas, pausar } from "./pausa";
import { listarPedidos } from "./pedidos";
import { catalogoCompleto, salvarCatalogo, telefoneDe } from "./tools";
import { acharContaServico, hojeISO, horariosLivres, proximoDiaAberto, rotuloDia, statusAgenda } from "./agenda";
import { adicionarVip, associarEtiqueta, ehVip, registrarEtiqueta, removerVip, resumoVip } from "./vip";

const app = express();
// Audio chega em base64 dentro do webhook: limite folgado.
app.use(express.json({ limit: "25mb" }));

// ---------------------------------------------------------------------------
// Payload da Evolution API v2 -- evento "messages.upsert"
// ---------------------------------------------------------------------------

interface EvoKey {
  remoteJid?: string;
  /** Telefone real quando remoteJid vem como "@lid" (versoes recentes). */
  remoteJidAlt?: string;
  senderPn?: string;
  fromMe?: boolean;
  id?: string;
}

interface EvoData {
  key?: EvoKey;
  pushName?: string;
  messageType?: string;
  message?: Record<string, any> & { base64?: string };
}

interface EvoWebhook {
  event?: string;
  instance?: string;
  data?: EvoData;
}

/** Texto de qualquer tipo de mensagem que tenha texto. */
function textoDe(m: EvoData["message"]): string {
  if (!m) return "";
  return String(
    m.conversation ??
      m.extendedTextMessage?.text ??
      m.imageMessage?.caption ??
      m.videoMessage?.caption ??
      m.buttonsResponseMessage?.selectedDisplayText ??
      m.listResponseMessage?.title ??
      ""
  ).trim();
}

/**
 * Mapa "@lid" -> telefone aprendido nas mensagens recebidas.
 *
 * O WhatsApp esta trocando o telefone por um id privado (@lid) no remoteJid.
 * Quando a Evolution manda o telefone junto (remoteJidAlt / senderPn), usamos
 * ele como chave da conversa: assim o pedido chega ao barbeiro com o numero
 * certo e uma mensagem digitada no celular cai na mesma conversa.
 */
const lidParaTelefone = new Map<string, string>();

function jidDaConversa(key: EvoKey): string | undefined {
  const remoto = key.remoteJid?.trim();
  if (!remoto) return undefined;
  if (!remoto.endsWith("@lid")) return remoto;
  const alt = [key.remoteJidAlt, key.senderPn].find((j) => j && j.includes("@s.whatsapp.net"));
  if (alt) {
    lidParaTelefone.set(remoto, alt);
    return alt;
  }
  return lidParaTelefone.get(remoto) ?? remoto;
}

function ignorarJid(jid: string): boolean {
  return (
    jid.endsWith("@g.us") || // grupos
    jid.endsWith("@broadcast") || // status / listas
    jid.endsWith("@newsletter") // canais
  );
}

// ---------------------------------------------------------------------------
// Agrupamento + fila por conversa
//
// No WhatsApp a pessoa manda "oi" / "vi no insta" / "ta quanto?" em 3 mensagens.
// Sem buffer o bot responde 3x e se perde -- o erro que denuncia robo na hora.
// ---------------------------------------------------------------------------

interface Recebida {
  remoteJid: string;
  id: string;
}

interface Buffer {
  partes: string[];
  lidas: Recebida[];
  timer: NodeJS.Timeout;
  nomeContato?: string;
}

const buffers = new Map<string, Buffer>();
/** Turnos em andamento: impede duas chamadas ao Gemini no mesmo historico. */
const emAndamento = new Map<string, Promise<void>>();
const mensagensRecebidas = new Map<string, number>();

function mensagemJaRecebida(chave: string): boolean {
  const agora = Date.now();
  const anterior = mensagensRecebidas.get(chave);
  if (anterior && agora - anterior < 10 * 60_000) return true;
  mensagensRecebidas.set(chave, agora);
  if (mensagensRecebidas.size > 5000) {
    for (const [id, quando] of mensagensRecebidas) {
      if (agora - quando >= 10 * 60_000 || mensagensRecebidas.size > 4500) {
        mensagensRecebidas.delete(id);
      }
    }
  }
  return false;
}

function agendar(chatid: string, texto: string, lida?: Recebida, nomeContato?: string): void {
  const existente = buffers.get(chatid);
  if (existente) {
    existente.partes.push(texto);
    if (lida) existente.lidas.push(lida);
    if (nomeContato) existente.nomeContato = nomeContato;
    clearTimeout(existente.timer); // cada mensagem nova reinicia a janela
    existente.timer = setTimeout(() => descarregar(chatid), config.debounceMs);
    return;
  }
  buffers.set(chatid, {
    partes: [texto],
    lidas: lida ? [lida] : [],
    nomeContato,
    timer: setTimeout(() => descarregar(chatid), config.debounceMs),
  });
}

function cancelarBuffer(chatid: string): void {
  const buf = buffers.get(chatid);
  if (!buf) return;
  clearTimeout(buf.timer);
  buffers.delete(chatid);
}

function descarregar(chatid: string): void {
  const buf = buffers.get(chatid);
  if (!buf) return;
  buffers.delete(chatid);

  const texto = buf.partes.join("\n");
  const anterior = emAndamento.get(chatid) ?? Promise.resolve();
  const atual = anterior
    .catch(() => {})
    .then(() => processar(chatid, texto, buf.lidas, buf.nomeContato));

  emAndamento.set(chatid, atual);
  void atual.finally(() => {
    if (emAndamento.get(chatid) === atual) emAndamento.delete(chatid);
  });
}

async function processar(
  chatid: string,
  texto: string,
  lidas: Recebida[],
  nomeContato?: string
): Promise<void> {
  console.log(`[webhook] <- ${chatid.split("@")[0]}: ${texto.replace(/\n/g, " | ")}`);
  const marcador = marcarHistorico(chatid);
  try {
    const r = await conduzir(chatid, texto, nomeContato);

    // Voce respondeu pelo celular enquanto a IA pensava: engole a resposta.
    if (estaPausado(chatid) || !config.agenteAtivo) {
      if (r.ia) desfazerTurno(chatid, marcador);
      console.log(`[webhook] ${chatid}: resposta descartada (humano assumiu / agente desligado)`);
      return;
    }

    // O cliente complementou enquanto a IA pensava: a resposta ja nasceu velha.
    // Desfaz o turno e devolve o texto ao buffer -- o proximo flush responde tudo.
    // (Mensagens fixas, como as boas-vindas, saem mesmo assim.)
    const chegouCoisaNova = buffers.get(chatid);
    if (r.ia && chegouCoisaNova) {
      desfazerTurno(chatid, marcador);
      chegouCoisaNova.partes.unshift(texto);
      chegouCoisaNova.lidas.unshift(...lidas);
      console.log(`[webhook] ${chatid}: resposta descartada, cliente complementou`);
      return;
    }

    await marcarComoLida(lidas);
    try {
      for (const m of r.mensagens) await enviarTexto(chatid, m, true);
    } finally {
      // Mesmo se o envio falhar, o resto acontece: o barbeiro e avisado na opcao 3,
      // o atendente se cala e o encerramento por inatividade fica armado.
      await executarAcao(chatid, r.acao, texto);
    }
  } catch (e) {
    // Nunca relanca: rejeicao solta aqui derruba o processo.
    console.error(`[webhook] falha ao atender ${chatid}:`, e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Fim de sessao: opcao 3, despedida e inatividade
// ---------------------------------------------------------------------------

/** Encerramento por inatividade armado no pos-reserva, por conversa. */
const timersInatividade = new Map<string, NodeJS.Timeout>();

function cancelarInatividade(chatid: string): void {
  const t = timersInatividade.get(chatid);
  if (t) clearTimeout(t);
  timersInatividade.delete(chatid);
}

/** Encerra tudo da conversa: a proxima mensagem do cliente comeca com as boas-vindas. */
function encerrarSessao(chatid: string, motivo: string): void {
  cancelarInatividade(chatid);
  cancelarBuffer(chatid);
  resetarSessao(chatid);
  console.log(`[sessao] ${chatid.split("@")[0]} encerrada (${motivo})`);
}

/**
 * Fecha a sessao se o cliente ficar `ms` sem escrever. Qualquer mensagem dele
 * cancela o timer (cancelarInatividade no webhook) e a conversa segue.
 * Com `aviso`, manda essa mensagem antes de fechar; sem, fecha em silencio.
 */
function armarInatividade(chatid: string, ms: number, motivo: string, aviso?: string): void {
  cancelarInatividade(chatid);
  const timer = setTimeout(() => {
    timersInatividade.delete(chatid);
    // Cliente escreveu (ou a IA ainda esta respondendo): nao e inatividade.
    if (buffers.has(chatid) || emAndamento.has(chatid) || estaPausado(chatid)) return;
    if (!aviso) {
      encerrarSessao(chatid, motivo);
      return;
    }
    void enviarTexto(chatid, aviso)
      .catch((e) => console.warn("[sessao] aviso de encerramento falhou:", e instanceof Error ? e.message : e))
      .finally(() => encerrarSessao(chatid, motivo));
  }, ms);
  timer.unref();
  timersInatividade.set(chatid, timer);
}

async function executarAcao(chatid: string, acao: Acao | undefined, ultimaMensagem: string): Promise<void> {
  if (acao === "posReserva") {
    armarInatividade(chatid, minutos(config.inatividadeMin, 5) * 60_000, "inatividade", config.mensagemEncerramento);
  } else if (acao === "despedida") {
    // A despedida ja saiu; se ele nao escrever mais nada no prazo, fecha sem outro aviso.
    armarInatividade(chatid, minutos(config.despedidaMin, 1) * 60_000, "cliente nao precisa de mais nada");
  } else if (acao === "humano") {
    const telefone = telefoneDe(chatid);
    encerrarSessao(chatid, "cliente pediu atendimento humano");
    // O atendente virtual sai da conversa pelo mesmo tempo do celular particular.
    pausar(chatid, minutos(config.pausaHumanoMin, 180) * 60_000, "cliente pediu atendimento humano");
    if (config.humanoWhatsapp) {
      const aviso = [
        "*Cliente pediu atendimento humano* 🙋",
        "",
        `WhatsApp: ${telefone}`,
        `Última mensagem: ${ultimaMensagem.slice(0, 300)}`,
        "",
        "Responda direto na conversa dele.",
      ].join("\n");
      await enviarTexto(config.humanoWhatsapp, aviso).catch((e) =>
        console.warn("[notificar] aviso de atendimento humano falhou:", e instanceof Error ? e.message : e)
      );
    }
  }
}

/** Audio -> texto. Sem base64 no webhook, pede para a Evolution baixar. */
async function textoDoAudio(data: EvoData): Promise<string> {
  const audio = data.message?.audioMessage;
  let base64 = data.message?.base64;
  if (!base64) base64 = await baixarMidia({ key: data.key, message: data.message });
  if (!base64) return "";
  try {
    const t = await transcreverAudio(base64, String(audio?.mimetype ?? "audio/ogg"));
    return t ? `[audio do cliente] ${t}` : "";
  } catch (e) {
    console.warn("[audio] transcricao falhou:", e instanceof Error ? e.message : e);
    return "";
  }
}

// ---------------------------------------------------------------------------
// Webhook (so a Evolution chama, pela rede interna do Docker)
// ---------------------------------------------------------------------------

function segredoConfere(recebido: unknown): boolean {
  if (!config.webhookSecret) return true;
  if (typeof recebido !== "string") return false;
  const a = new TextEncoder().encode(recebido);
  const b = new TextEncoder().encode(config.webhookSecret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Ultimo evento de conexao -- o painel usa para atualizar sem esperar. */
let ultimoEstado = "";

app.post("/webhook", (req, res) => {
  if (!segredoConfere(req.query.secret)) {
    res.sendStatus(401);
    return;
  }
  // Responde antes de processar: a Evolution reenvia se demorarmos.
  res.sendStatus(200);
  void tratarEvento(req.body as EvoWebhook).catch((e) =>
    console.error("[webhook] evento invalido:", e instanceof Error ? e.message : e)
  );
});

async function tratarEvento(body: EvoWebhook): Promise<void> {
  const evento = String(body?.event ?? "").toLowerCase().replace(/_/g, ".");

  if (evento === "connection.update") {
    const estado = (body.data as any)?.state;
    if (estado && estado !== ultimoEstado) {
      ultimoEstado = estado;
      console.log(`[whatsapp] conexao: ${estado}`);
    }
    return;
  }
  // Etiquetas do WhatsApp Business: mantem a lista "Clientes VIP" em dia.
  if (evento === "labels.edit") {
    const l = body.data as any;
    registrarEtiqueta(l?.id ?? l?.labelId, l?.name, l?.deleted === true);
    return;
  }
  if (evento === "labels.association") {
    const a = body.data as any;
    associarEtiqueta(a?.type, a?.chatId, a?.labelId);
    return;
  }
  if (evento !== "messages.upsert") return;

  const data = body.data;
  const key = data?.key;
  if (!data || !key) return;

  const chatid = jidDaConversa(key);
  if (!chatid || ignorarJid(chatid)) return;

  // Amigos e parentes: o atendente virtual nunca entra nessas conversas.
  if (ehVip(chatid, key.remoteJid, key.remoteJidAlt, key.senderPn)) {
    if (!key.fromMe) console.log(`[webhook] ${chatid.split("@")[0]}: VIP, atendimento pessoal`);
    return;
  }

  const texto = textoDe(data.message);

  // Mensagem saindo do numero da barbearia. Se nao foi o agente, alguem digitou
  // pelo celular: humano assumiu e o agente sai da frente.
  if (key.fromMe === true) {
    if (!foiOAgente(chatid, key.id, texto)) {
      // Celular particular: voce falou com essa pessoa, o atendente fica fora por 3h
      // (renovadas a cada mensagem sua). Depois, a conversa recomeca do zero.
      pausar(chatid, minutos(config.pausaHumanoMin, 180) * 60_000, "voce respondeu pelo celular");
      encerrarSessao(chatid, "voce assumiu pelo celular");
    }
    return;
  }

  if (!config.agenteAtivo) return;
  // O barbeiro respondendo ao aviso de pedido nao e cliente.
  if (config.humanoWhatsapp && chatid.split("@")[0] === config.humanoWhatsapp) return;
  if (estaPausado(chatid)) {
    console.log(`[webhook] ${chatid.split("@")[0]}: ignorado, conversa com humano`);
    return;
  }
  if (key.id && mensagemJaRecebida(`${chatid}:${key.id}`)) return;
  cancelarInatividade(chatid); // o cliente respondeu: nao e inatividade

  let conteudo = texto;
  if (!conteudo && data.message?.audioMessage && config.entenderAudio) {
    conteudo = await textoDoAudio(data);
  }
  if (!conteudo) {
    // Figurinha, foto sem legenda, localizacao... nao ha o que responder.
    if (data.message?.audioMessage || data.message?.imageMessage) {
      conteudo = "[o cliente mandou uma midia que voce nao consegue ver; peca para escrever]";
    } else return;
  }

  const lida = key.remoteJid && key.id ? { remoteJid: key.remoteJid, id: key.id } : undefined;
  agendar(chatid, conteudo, lida, data.pushName);
}

// ---------------------------------------------------------------------------
// Painel (http://localhost:3737) -- so este computador acessa
// ---------------------------------------------------------------------------

const subiuEm = new Date().toISOString();

app.get("/health", (_req, res) => {
  res.json({ ok: true, subiuEm, sessoes: totalSessoes(), modelo: config.geminiModel });
});

app.use(express.static(path.join(__dirname, "..", "public")));

const rota =
  (fn: (req: express.Request, res: express.Response) => Promise<void> | void) =>
  async (req: express.Request, res: express.Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      res.status(400).json({ erro: e instanceof Error ? e.message : String(e) });
    }
  };

app.get(
  "/api/status",
  rota(async (_req, res) => {
    const online = await evolutionOnline();
    const estado = online ? await estadoConexao() : "offline";
    const perfil = estado === "open" ? await perfilConectado() : {};
    const agenda = await statusAgenda();
    res.json({
      agenda,
      evolution: online,
      whatsapp: estado,
      numero: perfil.numero,
      perfil: perfil.nome,
      geminiConfigurado: !!config.geminiApiKey,
      agenteAtivo: config.agenteAtivo,
      modelo: config.geminiModel,
      empresa: config.empresaNome,
      sessoes: totalSessoes(),
      subiuEm,
    });
  })
);

app.get(
  "/api/qrcode",
  rota(async (_req, res) => {
    if ((await estadoConexao()) === "inexistente") await prepararInstancia();
    res.json(await gerarQrCode());
  })
);

app.post(
  "/api/pareamento",
  rota(async (req, res) => {
    const numero = String(req.body?.numero ?? "");
    if (numero.replace(/\D/g, "").length < 12) {
      throw new Error("Informe o numero completo com 55 + DDD. Ex: 5511999998888");
    }
    if ((await estadoConexao()) === "inexistente") await prepararInstancia();
    res.json({ codigo: await gerarCodigoPareamento(numero) });
  })
);

app.post(
  "/api/desconectar",
  rota(async (_req, res) => {
    await desconectar();
    res.json({ ok: true });
  })
);

app.get("/api/configuracoes", (_req, res) => {
  res.json({ ...configuracoesPublicas(), contaServicoEmail: acharContaServico()?.client_email ?? "" });
});

app.put(
  "/api/configuracoes",
  rota((req, res) => {
    salvarConfiguracoes((req.body ?? {}) as Record<string, unknown>);
    res.json(configuracoesPublicas());
  })
);

app.get("/api/catalogo", (_req, res) => {
  res.json(catalogoCompleto());
});

app.put(
  "/api/catalogo",
  rota((req, res) => {
    res.json(salvarCatalogo(req.body));
  })
);

/** Testa a agenda agora (sem cache) e mostra as vagas do proximo dia aberto. */
app.get(
  "/api/agenda/teste",
  rota(async (_req, res) => {
    const status = await statusAgenda(true);
    if (status.estado !== "conectada") {
      res.json({ status });
      return;
    }
    const dia = proximoDiaAberto(hojeISO());
    const horarios = dia ? await horariosLivres(dia, 30) : [];
    res.json({ status, exemplo: dia ? { dia: rotuloDia(dia), horarios } : null });
  })
);

// --- Clientes VIP ---

app.get("/api/vip", (_req, res) => {
  res.json(resumoVip());
});

app.post(
  "/api/vip",
  rota((req, res) => {
    adicionarVip(String(req.body?.numero ?? ""), String(req.body?.nome ?? ""));
    res.json(resumoVip());
  })
);

app.delete(
  "/api/vip/:numero",
  rota((req, res) => {
    removerVip(String(req.params.numero));
    res.json(resumoVip());
  })
);

/** Contatos do WhatsApp conectado, para escolher quem e VIP. */
app.get(
  "/api/contatos",
  rota(async (_req, res) => {
    if ((await estadoConexao()) !== "open") throw new Error("Conecte o WhatsApp para ver os contatos.");
    const contatos = await listarContatos();
    contatos.sort((a, b) => (a.nome || "~").localeCompare(b.nome || "~", "pt-BR"));
    res.json(contatos.map((c) => ({ numero: c.jid.split("@")[0], nome: c.nome })));
  })
);

/** Relê as etiquetas do WhatsApp Business (nome -> id). */
async function sincronizarEtiquetas(): Promise<void> {
  try {
    if ((await estadoConexao()) !== "open") return;
    for (const l of await listarEtiquetas()) registrarEtiqueta(l.id, l.nome);
  } catch (e) {
    console.warn("[vip] nao consegui ler as etiquetas:", e instanceof Error ? e.message : e);
  }
}

app.get("/api/pedidos", (_req, res) => {
  res.json(listarPedidos(200));
});

/** Simulador do painel: conversa com o agente sem WhatsApp. */
app.post(
  "/api/simular",
  rota(async (req, res) => {
    const sessao = `teste-${String(req.body?.sessao ?? "painel").replace(/[^\w-]/g, "")}`;
    if (req.body?.reiniciar) {
      resetarSessao(sessao);
      res.json({ ok: true });
      return;
    }
    const texto = String(req.body?.texto ?? "").trim();
    if (!texto) throw new Error("Digite uma mensagem.");
    // Mesmo fluxo do WhatsApp, mas sem avisar o barbeiro, sem pausar e sem timer.
    const r = await conduzir(sessao, texto, "Cliente Teste");
    let nota: string | undefined;
    if (r.acao === "humano") {
      resetarSessao(sessao);
      nota = `No WhatsApp: o barbeiro seria avisado e o atendente virtual ficaria fora desta conversa por ${minutos(config.pausaHumanoMin, 180) / 60}h. Sessão encerrada.`;
    } else if (r.acao === "despedida") {
      // No simulador nao ha timer: a sessao segue aberta para testar o "voltou a escrever".
      nota = `No WhatsApp: se o cliente não escrever nada em ${minutos(config.despedidaMin, 1)} min, a sessão é encerrada e a próxima mensagem começa com as boas-vindas. Se escrever antes, o atendimento continua.`;
    } else if (r.acao === "posReserva") {
      nota = `No WhatsApp: sem resposta em ${minutos(config.inatividadeMin, 5)} min, o cliente recebe a mensagem de encerramento e a sessão termina.`;
    }
    res.json({ mensagens: r.mensagens, nota });
  })
);

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

/**
 * Prepara a instancia na Evolution assim que ela estiver de pe. No primeiro
 * boot o Postgres e a Evolution demoram alguns segundos: tenta ate conseguir.
 */
async function prepararQuandoPronto(tentativa = 1): Promise<void> {
  try {
    await prepararInstancia();
    const estado = await estadoConexao();
    console.log(
      estado === "open"
        ? "[boot] WhatsApp conectado. Atendendo."
        : `[boot] WhatsApp ainda nao conectado. Abra http://localhost:${process.env.PAINEL_PORTA || 3737} e leia o QR Code.`
    );
  } catch (e) {
    const espera = Math.min(5_000 * tentativa, 30_000);
    if (tentativa === 1 || tentativa % 6 === 0) {
      console.log(`[boot] aguardando Evolution API... (${e instanceof Error ? e.message : e})`);
    }
    setTimeout(() => void prepararQuandoPronto(tentativa + 1), espera).unref();
  }
}

if (!config.webhookSecret) {
  console.warn("[boot] WEBHOOK_SECRET vazio: rode o instalador para gerar o .env completo.");
}
if (!config.geminiApiKey) {
  console.warn("[boot] Chave do Gemini nao configurada: preencha no painel.");
}

setInterval(() => {
  limparSessoesOciosas();
  limparEstadosOciosos(config.sessaoTtlMs);
}, 15 * 60 * 1000).unref();
setInterval(limparPausasVencidas, 15 * 60 * 1000).unref();
setInterval(() => void sincronizarEtiquetas(), 10 * 60 * 1000).unref();
setTimeout(() => void sincronizarEtiquetas(), 30_000).unref();

app.listen(config.porta, () => {
  console.log(`[boot] ${config.empresaNome} | modelo ${config.geminiModel}`);
  console.log(`[boot] agente ouvindo na porta ${config.porta}`);
  void prepararQuandoPronto();
});
