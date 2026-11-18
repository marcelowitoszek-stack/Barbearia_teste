import { handlers } from "./tools";

/**
 * Despacho das tools.
 *
 * Generico: quais tools existem e o que elas devolvem esta em tools.ts, que e o
 * arquivo do negocio. Aqui fica so a rede de protecao, que vale para qualquer nicho.
 */

export type Handler = (args: Record<string, unknown>, chatid: string) => unknown;

/**
 * Executa a tool que o modelo pediu (sincrona ou assincrona).
 *
 * Tool que lanca NAO pode derrubar o turno: o cliente ficaria sem resposta por
 * causa de um campo faltando ou da agenda fora do ar. Erro vira objeto de erro,
 * e o modelo contorna dentro da conversa.
 */
export async function executarTool(
  nome: string,
  args: Record<string, unknown>,
  chatid = "avulso"
): Promise<unknown> {
  const fn = handlers[nome];
  if (!fn) return { erro: `Ferramenta desconhecida: ${nome}` };
  try {
    return await fn(args, chatid);
  } catch (e) {
    console.error(`[tools] falha em ${nome}:`, e instanceof Error ? e.message : e);
    return { erro: "Falha ao consultar os dados. Diga que vai confirmar e siga a conversa." };
  }
}
