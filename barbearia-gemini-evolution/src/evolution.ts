import { assertEvolution, config } from "./config";

/**
 * Cliente da Evolution API v2 (WhatsApp gratuito via Baileys, roda local).
 *
 * Contratos usados (header `apikey: <AUTHENTICATION_API_KEY>`):
 *   POST   /instance/create                    cria a instancia
 *   GET    /instance/connectionState/{inst}    { instance: { state } }
 *   GET    /instance/connect/{inst}            { base64, code, pairingCode }
 *   GET    /instance/fetchInstances?instanceName=
 *   DELETE /instance/logout/{inst}
 *   POST   /webhook/set/{inst}                 { webhook: {...} }
 *   POST   /message/sendText/{inst}            { number, text, delay }
 *   POST   /chat/markMessageAsRead/{inst}      { readMessages: [...] }
 *   POST   /chat/getBase64FromMediaMessage/{inst}
 *
 * Marcar como lida e enfeite: falha em silencio. Envio de texto propaga erro.
 */

const inst = () => encodeURIComponent(config.evolutionInstancia);

async function chamar(
  metodo: "GET" | "POST" | "DELETE",
  rota: string,
  corpo?: unknown,
  timeoutMs = 20_000
): Promise<{ status: number; ok: boolean; dados: any }> {
  assertEvolution();
  const res = await fetch(`${config.evolutionUrl}${rota}`, {
    method: metodo,
    headers: { "Content-Type": "application/json", apikey: config.evolutionApiKey },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const texto = await res.text();
  let dados: any = texto;
  try {
    dados = texto ? JSON.parse(texto) : null;
  } catch {
    /* resposta nao-JSON: devolve o texto */
  }
  return { status: res.status, ok: res.ok, dados };
}

function erro(r: { status: number; dados: any }): Error {
  const msg = typeof r.dados === "string" ? r.dados : JSON.stringify(r.dados);
  return new Error(`Evolution ${r.status}: ${msg.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// Instancia
// ---------------------------------------------------------------------------

export type EstadoConexao = "open" | "connecting" | "close" | "inexistente" | "offline";

/** A Evolution esta de pe? */
export async function evolutionOnline(): Promise<boolean> {
  try {
    const res = await fetch(`${config.evolutionUrl}/`, { signal: AbortSignal.timeout(4_000) });
    return res.ok;
  } catch {
    return false;
  }
}

export async function estadoConexao(): Promise<EstadoConexao> {
  try {
    const r = await chamar("GET", `/instance/connectionState/${inst()}`, undefined, 8_000);
    if (r.status === 404) return "inexistente";
    if (!r.ok) return "offline";
    return (r.dados?.instance?.state ?? "close") as EstadoConexao;
  } catch {
    return "offline";
  }
}

/** Numero e nome do perfil conectado, para mostrar no painel. */
export async function perfilConectado(): Promise<{ numero?: string; nome?: string }> {
  try {
    const r = await chamar(
      "GET",
      `/instance/fetchInstances?instanceName=${inst()}`,
      undefined,
      8_000
    );
    const i = Array.isArray(r.dados) ? r.dados[0] : undefined;
    return {
      numero: i?.ownerJid ? String(i.ownerJid).split("@")[0] : undefined,
      nome: i?.profileName ?? undefined,
    };
  } catch {
    return {};
  }
}

// LABELS_*: etiquetas do WhatsApp Business (lista "Clientes VIP").
const EVENTOS = ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "LABELS_EDIT", "LABELS_ASSOCIATION"];

function webhookConfig() {
  const url = `${config.webhookUrlInterna}?secret=${encodeURIComponent(config.webhookSecret)}`;
  return {
    enabled: true,
    url,
    byEvents: false,
    // base64 = a Evolution ja manda o audio junto, sem segunda chamada.
    base64: config.entenderAudio,
    events: EVENTOS,
  };
}

/**
 * Garante que a instancia existe e que o webhook aponta para este agente.
 * Idempotente: roda em todo boot. Se a instancia ja existe, so reaplica o webhook.
 */
export async function prepararInstancia(): Promise<void> {
  const estado = await estadoConexao();
  if (estado === "offline") throw new Error("Evolution API ainda nao respondeu");

  if (estado === "inexistente") {
    const r = await chamar("POST", "/instance/create", {
      instanceName: config.evolutionInstancia,
      integration: "WHATSAPP-BAILEYS",
      qrcode: true,
      // Nao recusa ligacao, nao fica "online" o tempo todo, ignora grupos.
      groupsIgnore: true,
      alwaysOnline: false,
      readMessages: false,
      syncFullHistory: false,
      webhook: webhookConfig(),
    });
    if (!r.ok) throw erro(r);
    console.log(`[evolution] instancia "${config.evolutionInstancia}" criada`);
  }

  const w = await chamar("POST", `/webhook/set/${inst()}`, { webhook: webhookConfig() });
  if (!w.ok) throw erro(w);
  console.log("[evolution] webhook configurado (rede interna)");
}

/** QR Code para conectar o WhatsApp. `base64` ja vem como data URL de imagem. */
export async function gerarQrCode(): Promise<{ base64?: string; pairingCode?: string | null }> {
  const r = await chamar("GET", `/instance/connect/${inst()}`);
  if (!r.ok) throw erro(r);
  return { base64: r.dados?.base64, pairingCode: r.dados?.pairingCode ?? null };
}

/**
 * Codigo de pareamento: alternativa ao QR para quem so tem um celular
 * (WhatsApp > Aparelhos conectados > Conectar com numero de telefone).
 */
export async function gerarCodigoPareamento(numero: string): Promise<string | null> {
  const n = numero.replace(/\D/g, "");
  const r = await chamar("GET", `/instance/connect/${inst()}?number=${n}`);
  if (!r.ok) throw erro(r);
  return r.dados?.pairingCode ?? null;
}

export async function desconectar(): Promise<void> {
  const r = await chamar("DELETE", `/instance/logout/${inst()}`);
  if (!r.ok && r.status !== 400) throw erro(r);
}

// ---------------------------------------------------------------------------
// Mensagens
// ---------------------------------------------------------------------------

/**
 * Registro curto do que o PROPRIO agente enviou.
 *
 * A Evolution devolve no webhook, com fromMe=true, tanto o que o agente mandou
 * quanto o que alguem digitou no celular da barbearia. So o segundo caso deve
 * pausar o agente ("humano assumiu"). Guardamos id e texto do que saiu daqui
 * para separar um do outro -- o texto cobre a corrida em que o webhook chega
 * antes da resposta HTTP do envio.
 */
const enviadosIds = new Map<string, number>();
const enviadosTexto = new Map<string, number>();
const JANELA_MS = 2 * 60_000;

function chaveTexto(jid: string, texto: string): string {
  return `${jid.split("@")[0]}|${texto.trim().slice(0, 200)}`;
}

function limparEnviados(): void {
  const limite = Date.now() - JANELA_MS;
  for (const [k, t] of enviadosIds) if (t < limite) enviadosIds.delete(k);
  for (const [k, t] of enviadosTexto) if (t < limite) enviadosTexto.delete(k);
}

/** Essa mensagem fromMe foi o agente que mandou? */
export function foiOAgente(jid: string, id: string | undefined, texto: string): boolean {
  limparEnviados();
  if (id && enviadosIds.has(id)) return true;
  return texto.trim() !== "" && enviadosTexto.has(chaveTexto(jid, texto));
}

function tempoDigitando(texto: string): number {
  return Math.min(
    config.digitandoBaseMs + texto.length * config.digitandoPorCharMs,
    config.digitandoMaxMs
  );
}

/**
 * Envia texto. `jid` pode ser o numero puro ou o jid completo do WhatsApp.
 * Com humanizacao, a Evolution mostra "digitando..." pelo tempo de `delay`.
 */
export async function enviarTexto(jid: string, texto: string, humanizar = false): Promise<void> {
  const numero = jid.includes("@") ? jid : jid.replace(/\D/g, "");
  if (!numero) throw new Error(`destino invalido: ${jid}`);

  enviadosTexto.set(chaveTexto(numero, texto), Date.now());
  const delay = humanizar && config.humanizar ? tempoDigitando(texto) : 0;

  const r = await chamar(
    "POST",
    `/message/sendText/${inst()}`,
    { number: numero, text: texto, delay, linkPreview: false },
    30_000 + delay
  );
  if (!r.ok) throw erro(r);
  const id = r.dados?.key?.id;
  if (id) enviadosIds.set(String(id), Date.now());
  console.log(`[whatsapp] -> ${numero.split("@")[0]}: ${texto.replace(/\n/g, " | ")}`);
}

/** Dois tiques azuis. Falha em silencio. */
export async function marcarComoLida(
  mensagens: { remoteJid: string; id: string }[]
): Promise<void> {
  if (!config.humanizar || mensagens.length === 0) return;
  try {
    const r = await chamar(
      "POST",
      `/chat/markMessageAsRead/${inst()}`,
      { readMessages: mensagens.map((m) => ({ ...m, fromMe: false })) },
      8_000
    );
    if (!r.ok) console.warn(`[whatsapp] markread ${r.status} (ignorado)`);
  } catch (e) {
    console.warn("[whatsapp] markread falhou (ignorado):", e instanceof Error ? e.message : e);
  }
}

// ---------------------------------------------------------------------------
// Contatos e etiquetas (lista VIP)
// ---------------------------------------------------------------------------

/** Etiquetas do WhatsApp Business. Conta comum devolve lista vazia. */
export async function listarEtiquetas(): Promise<{ id: string; nome: string }[]> {
  const r = await chamar("GET", `/label/findLabels/${inst()}`, undefined, 10_000);
  if (!r.ok || !Array.isArray(r.dados)) return [];
  return r.dados
    .map((l: any) => ({ id: String(l?.id ?? l?.labelId ?? ""), nome: String(l?.name ?? "") }))
    .filter((l: { id: string; nome: string }) => l.id && l.nome);
}

/** Contatos que o WhatsApp sincronizou (so pessoas, sem grupos). */
export async function listarContatos(): Promise<{ jid: string; nome: string }[]> {
  const r = await chamar("POST", `/chat/findContacts/${inst()}`, { where: {} }, 20_000);
  if (!r.ok) throw erro(r);
  if (!Array.isArray(r.dados)) return [];
  return r.dados
    .filter((c: any) => typeof c?.remoteJid === "string" && c.remoteJid.endsWith("@s.whatsapp.net"))
    .map((c: any) => ({ jid: c.remoteJid as string, nome: String(c.pushName ?? "").trim() }));
}

/** Baixa a midia de uma mensagem (quando o webhook nao trouxe o base64). */
export async function baixarMidia(mensagemCompleta: unknown): Promise<string | undefined> {
  try {
    const r = await chamar(
      "POST",
      `/chat/getBase64FromMediaMessage/${inst()}`,
      { message: mensagemCompleta, convertToMp4: false },
      30_000
    );
    return r.ok ? (r.dados?.base64 as string | undefined) : undefined;
  } catch {
    return undefined;
  }
}
