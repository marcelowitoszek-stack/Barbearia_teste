import * as fs from "node:fs";
import * as path from "node:path";
import { dadosDir } from "./config";

/**
 * Historico de pedidos em dados/pedidos.jsonl (uma linha JSON por pedido).
 *
 * Arquivo simples de proposito: sobrevive a reinicio, abre no Bloco de Notas,
 * vai para backup copiando a pasta `dados` e nao exige banco.
 */

export interface Pedido {
  nome: string;
  servico: string;
  diaHorario: string;
  barbeiro: string;
  jaCliente: string;
  telefone: string;
  registradoEm: string;
  /** "AAAA-MM-DDTHH:MM" quando o horario e exato. */
  dataHora?: string;
  /** Situacao na Google Agenda ("✅ na Google Agenda", "⚠️ ..."). */
  agenda?: string;
  agendaLink?: string;
  atualizado?: boolean;
  teste?: boolean;
}

const arquivo = () => path.join(dadosDir, "pedidos.jsonl");

export function salvarPedido(p: Pedido): void {
  try {
    fs.mkdirSync(dadosDir, { recursive: true });
    fs.appendFileSync(arquivo(), JSON.stringify(p) + "\n", "utf8");
  } catch (e) {
    // Nunca derruba o atendimento: o pedido ainda vai para o WhatsApp e o log.
    console.error("[pedidos] falha ao gravar:", e);
  }
}

/** Os mais recentes primeiro. */
export function listarPedidos(limite = 100): Pedido[] {
  try {
    const linhas = fs.readFileSync(arquivo(), "utf8").split("\n").filter(Boolean);
    return linhas
      .slice(-limite)
      .reverse()
      .flatMap((l) => {
        try {
          return [JSON.parse(l) as Pedido];
        } catch {
          return [];
        }
      });
  } catch {
    return [];
  }
}
