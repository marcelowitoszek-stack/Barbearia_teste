import * as fs from "node:fs";
import * as path from "node:path";
import { dadosDir } from "./config";

/**
 * Silencia o atendente virtual numa conversa.
 *
 * Tres situacoes:
 * 1. Voce mandou mensagem pelo celular (cliente, familia, qualquer um): o numero
 *    e particular, entao o atendente fica fora daquela conversa por 3h, renovadas
 *    a cada mensagem sua. Depois disso a conversa volta ao fluxo normal.
 * 2. O cliente escolheu a opcao 3 (atendimento humano).
 * 3. Pedido que nao entrou na agenda: o barbeiro assume.
 *
 * Gravado em dados/pausas.json: se o computador reiniciar no meio de uma conversa
 * sua com a familia, o atendente NAO pode voltar a responder por cima.
 */

const pausados = new Map<string, number>();
const arquivo = () => path.join(dadosDir, "pausas.json");

function carregar(): void {
  try {
    const bruto = JSON.parse(fs.readFileSync(arquivo(), "utf8")) as Record<string, number>;
    const agora = Date.now();
    for (const [chatid, ate] of Object.entries(bruto)) {
      if (typeof ate === "number" && ate > agora) pausados.set(chatid, ate);
    }
  } catch {
    /* primeira execucao ou arquivo invalido: comeca vazio */
  }
}

function gravar(): void {
  try {
    fs.mkdirSync(dadosDir, { recursive: true });
    fs.writeFileSync(arquivo(), JSON.stringify(Object.fromEntries(pausados)), "utf8");
  } catch (e) {
    console.warn("[pausa] nao consegui gravar pausas.json:", e instanceof Error ? e.message : e);
  }
}

export function pausar(chatid: string, ms: number, motivo: string): void {
  const ate = Date.now() + ms;
  const anterior = pausados.get(chatid) ?? 0;
  // Nunca encurta uma pausa existente; cada nova mensagem sua empurra o fim para frente.
  if (ate > anterior) {
    pausados.set(chatid, ate);
    gravar();
  }
  console.log(`[pausa] ${chatid.split("@")[0]} silenciado por ${Math.round(ms / 60000)}min (${motivo})`);
}

export function estaPausado(chatid: string): boolean {
  const ate = pausados.get(chatid);
  if (!ate) return false;
  if (Date.now() >= ate) {
    pausados.delete(chatid);
    gravar();
    return false;
  }
  return true;
}

/** Varre pausas vencidas para o Map nao crescer sem limite. */
export function limparPausasVencidas(): void {
  const agora = Date.now();
  let mudou = false;
  for (const [chatid, ate] of pausados) {
    if (agora >= ate) {
      pausados.delete(chatid);
      mudou = true;
    }
  }
  if (mudou) gravar();
}

carregar();
