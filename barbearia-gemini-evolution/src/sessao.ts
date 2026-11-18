/**
 * Em que ponto do atendimento cada conversa esta.
 *
 *   (sem sessao) --1a mensagem--> menu --"2"--> ia --reserva na agenda--> posReserva
 *                                  |              |                          |
 *                                  |              +-- "nao, so isso" --> despedida (1 min sem escrever)
 *                                  |                                         |
 *                                  +--"3"--> humano (sessao encerrada)        +-- 5 min sem resposta
 *                                                                              v
 *                                                                        sessao encerrada
 *
 * Na despedida, se o cliente escrever antes do prazo, a conversa continua.
 *
 * Sessao encerrada = proxima mensagem do cliente comeca do zero (boas-vindas de novo).
 *
 * Modulo sem dependencias de proposito: tools.ts precisa marcar "reservou" e
 * "encerrar", e o fluxo precisa do agente, que precisa de tools.ts. Morando aqui,
 * ninguem importa ninguem em circulo.
 */

export type Fase = "menu" | "ia";

export interface EstadoSessao {
  fase: Fase;
  /** O que o cliente escreveu antes de escolher a opcao (vai junto para a IA). */
  pendente: string[];
  /** Reservou na agenda: a partir daqui vale o encerramento por inatividade. */
  posReserva: boolean;
  /**
   * A IA marcou a despedida neste turno (cliente disse que nao precisa de mais
   * nada). Vale so para o turno: o fluxo le e zera. Se o cliente voltar a escrever
   * antes do prazo, a conversa segue normalmente.
   */
  encerrar: boolean;
  ultimoAcesso: number;
}

const estados = new Map<string, EstadoSessao>();

export function estadoDe(chatid: string): EstadoSessao | undefined {
  const e = estados.get(chatid);
  if (e) e.ultimoAcesso = Date.now();
  return e;
}

export function iniciarSessao(chatid: string, primeiraMensagem: string): EstadoSessao {
  const e: EstadoSessao = {
    fase: "menu",
    pendente: [primeiraMensagem],
    posReserva: false,
    encerrar: false,
    ultimoAcesso: Date.now(),
  };
  estados.set(chatid, e);
  return e;
}

export function apagarEstado(chatid: string): void {
  estados.delete(chatid);
}

/** Chamado por registrarLead quando o horario entrou na agenda. */
export function marcarPosReserva(chatid: string): void {
  const e = estados.get(chatid);
  if (e) e.posReserva = true;
}

export function emPosReserva(chatid: string): boolean {
  return estados.get(chatid)?.posReserva === true;
}

/** Chamado pela tool encerrarAtendimento. */
export function marcarEncerrar(chatid: string): void {
  const e = estados.get(chatid);
  if (e) e.encerrar = true;
}

/** Mesma validade das conversas do agente: sessao ociosa recomeca do menu. */
export function limparEstadosOciosos(ttlMs: number): void {
  const limite = Date.now() - ttlMs;
  for (const [chatid, e] of estados) if (e.ultimoAcesso < limite) estados.delete(chatid);
}
