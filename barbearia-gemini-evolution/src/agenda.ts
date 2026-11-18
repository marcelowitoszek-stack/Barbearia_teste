import { createSign } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { config, dadosDir } from "./config";

/**
 * Google Agenda via conta de servico.
 *
 * Por que conta de servico e nao "Entrar com Google": o login OAuth de app em
 * modo teste expira a cada 7 dias e o barbeiro nao vai refazer isso. A conta de
 * servico e um arquivo .json em dados/ + a agenda compartilhada com o e-mail dela.
 * Nao expira e se repete igual em qualquer computador.
 *
 * Sem biblioteca do Google: o JWT e assinado com node:crypto e as duas chamadas
 * que importam (listar eventos e criar/alterar evento) sao REST puro.
 */

const API = "https://www.googleapis.com/calendar/v3";
const ESCOPO = "https://www.googleapis.com/auth/calendar";

// ---------------------------------------------------------------------------
// Chave da conta de servico
// ---------------------------------------------------------------------------

interface ContaServico {
  client_email: string;
  private_key: string;
  token_uri?: string;
  arquivo: string;
}

/** Procura em dados/ qualquer .json que seja chave de conta de servico. */
export function acharContaServico(): ContaServico | undefined {
  let arquivos: string[];
  try {
    arquivos = fs.readdirSync(dadosDir).filter((a) => a.toLowerCase().endsWith(".json"));
  } catch {
    return undefined;
  }
  for (const a of arquivos) {
    if (a === "catalogo.json" || a === "configuracoes.json") continue;
    try {
      const d = JSON.parse(fs.readFileSync(path.join(dadosDir, a), "utf8"));
      if (d?.type === "service_account" && d.client_email && d.private_key) {
        return { client_email: d.client_email, private_key: d.private_key, token_uri: d.token_uri, arquivo: a };
      }
    } catch {
      /* nao e JSON valido: ignora */
    }
  }
  return undefined;
}

/** Chave + ID da agenda presentes. Nao garante que o compartilhamento esta certo. */
export function agendaConfigurada(): boolean {
  return !!config.agendaId && !!acharContaServico();
}

const b64url = (s: string | Buffer) =>
  Buffer.from(s).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

let token: { valor: string; expira: number; email: string } | undefined;

async function accessToken(): Promise<string> {
  const conta = acharContaServico();
  if (!conta) throw new Error("Chave da conta de servico nao encontrada na pasta dados/.");
  if (token && token.email === conta.client_email && Date.now() < token.expira - 60_000) {
    return token.valor;
  }
  const aud = conta.token_uri || "https://oauth2.googleapis.com/token";
  const agora = Math.floor(Date.now() / 1000);
  const cabeca = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const corpo = b64url(
    JSON.stringify({ iss: conta.client_email, scope: ESCOPO, aud, iat: agora, exp: agora + 3600 })
  );
  const assinatura = b64url(
    createSign("RSA-SHA256").update(`${cabeca}.${corpo}`).sign(conta.private_key)
  );

  const res = await fetch(aud, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${cabeca}.${corpo}.${assinatura}`,
    }),
    signal: AbortSignal.timeout(15_000),
  });
  const d = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
  if (!res.ok || !d.access_token) {
    throw new Error(`Google recusou a chave: ${d.error_description ?? res.status}`);
  }
  token = { valor: d.access_token, expira: Date.now() + (d.expires_in ?? 3600) * 1000, email: conta.client_email };
  return token.valor;
}

/** A chave e aceita pelo Google? (nao depende do ID da agenda) */
export async function testarChave(): Promise<void> {
  token = undefined;
  await accessToken();
}

class ErroAgenda extends Error {
  constructor(public status: number, mensagem: string) {
    super(mensagem);
  }
}

async function gapi(metodo: "GET" | "POST" | "PATCH", rota: string, corpo?: unknown): Promise<any> {
  const res = await fetch(`${API}${rota}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
    signal: AbortSignal.timeout(15_000),
  });
  const d = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (d as any)?.error?.message ?? `HTTP ${res.status}`;
    if (res.status === 404 || res.status === 403) {
      const email = acharContaServico()?.client_email ?? "o e-mail da conta de servico";
      throw new ErroAgenda(
        res.status,
        `Sem acesso a agenda "${config.agendaId}". Confira o ID da agenda e se ela esta compartilhada com ${email} com permissao "Fazer alteracoes nos eventos". (${msg})`
      );
    }
    throw new ErroAgenda(res.status, `Google Agenda: ${msg}`);
  }
  return d;
}

const idAgenda = () => encodeURIComponent(config.agendaId);

// ---------------------------------------------------------------------------
// Datas no fuso da barbearia
// ---------------------------------------------------------------------------

/** Minutos que o fuso esta a frente do UTC naquele instante (Brasil: -180). */
function offsetMin(instante: Date): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: config.timezone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(instante)
      .map((x) => [x.type, x.value])
  );
  const comoUtc = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!, +p.second!);
  return Math.round((comoUtc - instante.getTime()) / 60_000);
}

/** "2026-11-14" + 600 (10:00) no fuso da barbearia -> instante real. */
function localParaInstante(dataISO: string, minutosDoDia: number): Date {
  const [y, m, d] = dataISO.split("-").map(Number);
  const palpite = Date.UTC(y!, m! - 1, d!, 0, minutosDoDia);
  let r = palpite - offsetMin(new Date(palpite)) * 60_000;
  const ajuste = offsetMin(new Date(r)); // horario de verao: confere de novo
  r = palpite - ajuste * 60_000;
  return new Date(r);
}

export function hojeISO(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: config.timezone }).format(new Date());
}

export function somarDias(dataISO: string, n: number): string {
  const [y, m, d] = dataISO.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d! + n)).toISOString().slice(0, 10);
}

function diaDaSemana(dataISO: string): number {
  const [y, m, d] = dataISO.split("-").map(Number);
  return new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
}

/** "2026-11-14" -> "sábado 14/11" */
export function rotuloDia(dataISO: string): string {
  const [y, m, d] = dataISO.split("-").map(Number);
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "UTC",
    weekday: "long",
    day: "2-digit",
    month: "2-digit",
  })
    .format(new Date(Date.UTC(y!, m! - 1, d!, 12)))
    .replace(",", "");
}

const hhmmParaMin = (h: string) => {
  const [a, b] = h.split(":").map(Number);
  return (a ?? 0) * 60 + (b ?? 0);
};
const minParaHhmm = (m: number) =>
  `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

export function dataValida(dataISO: unknown): dataISO is string {
  if (typeof dataISO !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(dataISO)) return false;
  return somarDias(dataISO, 0) === dataISO; // rejeita 2026-02-31
}

// ---------------------------------------------------------------------------
// Horarios livres
// ---------------------------------------------------------------------------

interface Ocupado {
  inicio: number; // epoch ms
  fim: number;
}

/** Eventos que bloqueiam horario entre dois instantes. */
async function ocupados(de: Date, ate: Date, ignorarEventoId?: string): Promise<Ocupado[]> {
  const q = new URLSearchParams({
    timeMin: de.toISOString(),
    timeMax: ate.toISOString(),
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "250",
  });
  const d = await gapi("GET", `/calendars/${idAgenda()}/events?${q}`);
  const lista: Ocupado[] = [];
  for (const e of (d.items ?? []) as any[]) {
    if (e.status === "cancelled") continue;
    if (ignorarEventoId && e.id === ignorarEventoId) continue;
    // "Disponivel" no Google (transparent) nao bloqueia: aniversarios, lembretes,
    // e por padrao os eventos de dia inteiro. Folga/feriado marque como "Ocupado".
    if (e.transparency === "transparent") continue;
    const ini = e.start?.dateTime
      ? Date.parse(e.start.dateTime)
      : e.start?.date
        ? localParaInstante(e.start.date, 0).getTime()
        : NaN;
    const fim = e.end?.dateTime
      ? Date.parse(e.end.dateTime)
      : e.end?.date
        ? localParaInstante(e.end.date, 0).getTime()
        : NaN;
    if (Number.isFinite(ini) && Number.isFinite(fim)) lista.push({ inicio: ini, fim });
  }
  return lista;
}

function expediente() {
  return {
    abre: hhmmParaMin(config.horaAbertura),
    fecha: hhmmParaMin(config.horaFechamento),
    pausaIni: config.almocoInicio ? hhmmParaMin(config.almocoInicio) : -1,
    pausaFim: config.almocoFim ? hhmmParaMin(config.almocoFim) : -1,
    dias: config.diasFuncionamento
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n >= 0 && n <= 6),
    passo: Math.max(5, Number(config.intervaloMin) || 30),
    capacidade: Math.max(1, Number(config.atendimentosSimultaneos) || 1),
    antecedencia: Math.max(0, Number(config.antecedenciaMin) || 0),
  };
}

export function abertoNoDia(dataISO: string): boolean {
  return expediente().dias.includes(diaDaSemana(dataISO));
}

/** Candidatos do expediente que cabem a duracao, sem olhar a agenda ainda. */
function candidatos(dataISO: string, duracaoMin: number): number[] {
  const e = expediente();
  if (!e.dias.includes(diaDaSemana(dataISO))) return [];
  const limite = Date.now() + e.antecedencia * 60_000;
  const lista: number[] = [];
  for (let m = e.abre; m + duracaoMin <= e.fecha; m += e.passo) {
    const cruzaPausa = e.pausaIni >= 0 && e.pausaFim > e.pausaIni && m < e.pausaFim && m + duracaoMin > e.pausaIni;
    if (cruzaPausa) continue;
    if (localParaInstante(dataISO, m).getTime() < limite) continue;
    lista.push(m);
  }
  return lista;
}

function cabe(inicio: number, fim: number, ocup: Ocupado[], capacidade: number): boolean {
  // Conta quantos eventos se sobrepoem. Com 3 cadeiras, 2 ocupadas ainda cabe.
  return ocup.filter((o) => o.inicio < fim && o.fim > inicio).length < capacidade;
}

/** Horarios livres ("HH:MM") de um dia para um servico com essa duracao. */
export async function horariosLivres(dataISO: string, duracaoMin: number): Promise<string[]> {
  const cands = candidatos(dataISO, duracaoMin);
  if (cands.length === 0) return [];
  const ocup = await ocupados(localParaInstante(dataISO, 0), localParaInstante(dataISO, 24 * 60));
  const cap = expediente().capacidade;
  return cands
    .filter((m) => {
      const ini = localParaInstante(dataISO, m).getTime();
      return cabe(ini, ini + duracaoMin * 60_000, ocup, cap);
    })
    .map(minParaHhmm);
}

/** Confere de novo um horario especifico (o cliente pode ter demorado a responder). */
export async function horarioLivre(
  dataISO: string,
  hhmm: string,
  duracaoMin: number,
  ignorarEventoId?: string
): Promise<boolean> {
  const m = hhmmParaMin(hhmm);
  if (!candidatos(dataISO, duracaoMin).includes(m)) return false;
  const ini = localParaInstante(dataISO, m);
  const fim = new Date(ini.getTime() + duracaoMin * 60_000);
  const ocup = await ocupados(ini, fim, ignorarEventoId);
  return cabe(ini.getTime(), fim.getTime(), ocup, expediente().capacidade);
}

// ---------------------------------------------------------------------------
// Eventos
// ---------------------------------------------------------------------------

export interface DadosEvento {
  dataISO: string;
  hhmm: string;
  duracaoMin: number;
  titulo: string;
  descricao: string;
}

function corpoEvento(e: DadosEvento) {
  const fimMin = hhmmParaMin(e.hhmm) + e.duracaoMin;
  // Atravessar a meia-noite nao acontece em expediente real; mesmo assim, seguro.
  const diaFim = fimMin >= 24 * 60 ? somarDias(e.dataISO, 1) : e.dataISO;
  return {
    summary: e.titulo,
    description: e.descricao,
    start: { dateTime: `${e.dataISO}T${e.hhmm}:00`, timeZone: config.timezone },
    end: { dateTime: `${diaFim}T${minParaHhmm(fimMin % (24 * 60))}:00`, timeZone: config.timezone },
    reminders: { useDefault: true },
  };
}

export async function criarEvento(e: DadosEvento): Promise<{ id: string; link: string }> {
  const d = await gapi("POST", `/calendars/${idAgenda()}/events`, corpoEvento(e));
  return { id: d.id, link: d.htmlLink };
}

export async function alterarEvento(id: string, e: DadosEvento): Promise<{ id: string; link: string }> {
  const d = await gapi("PATCH", `/calendars/${idAgenda()}/events/${encodeURIComponent(id)}`, corpoEvento(e));
  return { id: d.id, link: d.htmlLink };
}

export async function apagarEvento(id: string): Promise<void> {
  const res = await fetch(`${API}/calendars/${idAgenda()}/events/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${await accessToken()}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok && res.status !== 410) throw new ErroAgenda(res.status, `Google Agenda: HTTP ${res.status}`);
}

// ---------------------------------------------------------------------------
// Status para o painel
// ---------------------------------------------------------------------------

export interface StatusAgenda {
  estado: "conectada" | "sem-chave" | "sem-id" | "erro";
  email?: string;
  nome?: string;
  erro?: string;
}

let cacheStatus: { valor: StatusAgenda; quando: number; chave: string } | undefined;

export async function statusAgenda(forcar = false): Promise<StatusAgenda> {
  const conta = acharContaServico();
  if (!conta) return { estado: "sem-chave" };
  if (!config.agendaId) return { estado: "sem-id", email: conta.client_email };

  const chave = `${conta.client_email}|${config.agendaId}`;
  if (!forcar && cacheStatus && cacheStatus.chave === chave && Date.now() - cacheStatus.quando < 60_000) {
    return cacheStatus.valor;
  }
  let valor: StatusAgenda;
  try {
    // Ler eventos e o que o agente precisa; e tambem o teste mais fiel de permissao.
    const agora = new Date();
    await ocupados(agora, new Date(agora.getTime() + 60_000));
    const meta = await gapi("GET", `/calendars/${idAgenda()}`).catch(() => ({}));
    valor = { estado: "conectada", email: conta.client_email, nome: meta?.summary };
  } catch (e) {
    valor = { estado: "erro", email: conta.client_email, erro: e instanceof Error ? e.message : String(e) };
  }
  cacheStatus = { valor, quando: Date.now(), chave };
  return valor;
}

/** Primeiro dia aberto a partir de `de` (inclusive), ate 14 dias. */
export function proximoDiaAberto(de: string): string | undefined {
  for (let i = 0; i < 14; i++) {
    const d = somarDias(de, i);
    if (abertoNoDia(d)) return d;
  }
  return undefined;
}
