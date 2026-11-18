import * as fs from "node:fs";
import * as path from "node:path";
import { config, dadosDir } from "./config";
import { normalizar } from "./catalogo";

/**
 * Clientes VIP: amigos e parentes que NUNCA passam pelo atendente virtual.
 * Mensagem de um VIP e ignorada pelo agente -- voce responde pessoalmente.
 *
 * Duas fontes, somadas:
 *
 * 1. Etiqueta do WhatsApp Business (padrao "Clientes VIP"). Quando voce etiqueta
 *    uma conversa no celular, a Evolution avisa pelo webhook (labels.association)
 *    e o contato vira VIP na hora; tirar a etiqueta tira o VIP. Ao escanear o QR,
 *    o WhatsApp reenvia todas as etiquetas, entao a lista se monta sozinha.
 *    (No WhatsApp comum nao existem etiquetas, e as "Listas" do app nao sao
 *    expostas por nenhuma API -- por isso a fonte 2.)
 *
 * 2. Lista do painel: voce escolhe entre os contatos do WhatsApp ou digita o numero.
 *
 * Gravado em dados/vip.json para sobreviver a reinicios.
 */

interface VipManual {
  numero: string;
  nome: string;
}

interface Estado {
  manuais: VipManual[];
  /** labelId -> nome da etiqueta (aprendido no webhook ou em findLabels). */
  etiquetas: Record<string, string>;
  /** labelId -> conversas com essa etiqueta (jid como veio do WhatsApp). */
  associacoes: Record<string, string[]>;
}

const estado: Estado = { manuais: [], etiquetas: {}, associacoes: {} };
const arquivo = () => path.join(dadosDir, "vip.json");

function carregar(): void {
  try {
    const bruto = JSON.parse(fs.readFileSync(arquivo(), "utf8")) as Partial<Estado>;
    estado.manuais = Array.isArray(bruto.manuais) ? bruto.manuais.filter((m) => m && m.numero) : [];
    estado.etiquetas = bruto.etiquetas && typeof bruto.etiquetas === "object" ? bruto.etiquetas : {};
    estado.associacoes = bruto.associacoes && typeof bruto.associacoes === "object" ? bruto.associacoes : {};
  } catch {
    /* primeira execucao: comeca vazio */
  }
}

function gravar(): void {
  try {
    fs.mkdirSync(dadosDir, { recursive: true });
    fs.writeFileSync(arquivo(), JSON.stringify(estado, null, 2), "utf8");
  } catch (e) {
    console.warn("[vip] nao consegui gravar vip.json:", e instanceof Error ? e.message : e);
  }
}

carregar();

// ---------------------------------------------------------------------------
// Comparacao de numeros
// ---------------------------------------------------------------------------

/** So digitos, com 55 quando vier sem o codigo do pais. */
export function normalizarNumero(valor: string): string {
  let d = String(valor).split("@")[0]!.replace(/\D/g, "");
  if (/^\d{10,11}$/.test(d)) d = `55${d}`;
  return d;
}

/**
 * Chave de comparacao que ignora o nono digito: o WhatsApp guarda numeros
 * antigos de celular sem o 9 ("554188764833"), mas voce vai digitar com ele.
 * Para numero brasileiro: 55 + DDD + ultimos 8 digitos.
 */
function chave(valor: string): string {
  const jid = String(valor);
  if (jid.endsWith("@lid")) return jid; // id privado: so bate com ele mesmo
  const d = normalizarNumero(jid);
  if (d.startsWith("55") && (d.length === 12 || d.length === 13)) return `55${d.slice(2, 4)}${d.slice(-8)}`;
  return d;
}

// ---------------------------------------------------------------------------
// Consulta
// ---------------------------------------------------------------------------

function idsEtiquetaVip(): string[] {
  const alvo = normalizar(config.vipEtiqueta || "Clientes VIP");
  return Object.entries(estado.etiquetas)
    .filter(([, nome]) => normalizar(nome) === alvo)
    .map(([id]) => id);
}

function membrosEtiqueta(): string[] {
  const membros = new Set<string>();
  for (const id of idsEtiquetaVip()) for (const jid of estado.associacoes[id] ?? []) membros.add(jid);
  return [...membros];
}

/**
 * Essa conversa e de um VIP? Recebe todas as formas conhecidas do contato
 * (telefone e @lid), porque a etiqueta pode ter vindo com qualquer uma delas.
 */
export function ehVip(...jids: (string | undefined)[]): boolean {
  const chaves = new Set(jids.filter((j): j is string => !!j).map(chave));
  if (chaves.size === 0) return false;
  if (estado.manuais.some((m) => chaves.has(chave(m.numero)))) return true;
  return membrosEtiqueta().some((j) => chaves.has(chave(j)));
}

// ---------------------------------------------------------------------------
// Etiquetas (webhook da Evolution)
// ---------------------------------------------------------------------------

/** labels.edit / findLabels: guarda o nome de cada etiqueta. */
export function registrarEtiqueta(id: unknown, nome: unknown, apagada = false): void {
  if (id === undefined || id === null || id === "") return;
  const k = String(id);
  if (apagada) {
    delete estado.etiquetas[k];
    delete estado.associacoes[k];
  } else if (typeof nome === "string" && nome.trim()) {
    if (estado.etiquetas[k] === nome.trim()) return;
    estado.etiquetas[k] = nome.trim();
  } else return;
  gravar();
}

/** labels.association: etiqueta colocada ou tirada de uma conversa. */
export function associarEtiqueta(tipo: unknown, chatId: unknown, labelId: unknown): void {
  if (typeof chatId !== "string" || !chatId || labelId === undefined || labelId === null) return;
  const k = String(labelId);
  const lista = new Set(estado.associacoes[k] ?? []);
  if (tipo === "add") lista.add(chatId);
  else if (tipo === "remove") lista.delete(chatId);
  else return;
  estado.associacoes[k] = [...lista];
  gravar();
  if (idsEtiquetaVip().includes(k)) {
    console.log(`[vip] ${chatId.split("@")[0]} ${tipo === "add" ? "entrou na" : "saiu da"} etiqueta VIP`);
  }
}

// ---------------------------------------------------------------------------
// Lista manual (painel)
// ---------------------------------------------------------------------------

export function adicionarVip(numero: string, nome: string): void {
  const n = normalizarNumero(numero);
  if (n.length < 12 || n.length > 15) throw new Error("Numero invalido. Use DDD + numero, ex: 41999998888.");
  const existente = estado.manuais.find((m) => chave(m.numero) === chave(n));
  if (existente) existente.nome = nome.trim() || existente.nome;
  else estado.manuais.push({ numero: n, nome: nome.trim() });
  gravar();
}

export function removerVip(numero: string): void {
  const k = chave(numero);
  const antes = estado.manuais.length;
  estado.manuais = estado.manuais.filter((m) => chave(m.numero) !== k);
  if (estado.manuais.length === antes) throw new Error("Esse numero nao esta na lista do painel.");
  gravar();
}

export function resumoVip() {
  const ids = idsEtiquetaVip();
  return {
    etiquetaNome: config.vipEtiqueta || "Clientes VIP",
    etiquetaEncontrada: ids.length > 0,
    etiquetasConhecidas: Object.values(estado.etiquetas),
    daEtiqueta: membrosEtiqueta(),
    manuais: estado.manuais,
  };
}
