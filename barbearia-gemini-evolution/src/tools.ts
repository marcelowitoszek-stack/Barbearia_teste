import type { FunctionDeclaration } from "@google/genai";
import { config, dadosDir, minutos } from "./config";
import { marcarEncerrar, marcarPosReserva } from "./sessao";
import { notificarLead } from "./notificar";
import { pausar } from "./pausa";
import {
  duracao,
  guardarLead,
  leadAnterior,
  moeda,
  preferir,
  normalizar,
  ranquear,
  type Campo,
} from "./catalogo";
import {
  abertoNoDia,
  agendaConfigurada,
  alterarEvento,
  criarEvento,
  dataValida,
  hojeISO,
  horarioLivre,
  horariosLivres,
  rotuloDia,
  somarDias,
} from "./agenda";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Handler } from "./tool-runner";
import { salvarPedido } from "./pedidos";

/**
 * A CAMADA DO NEGOCIO.
 *
 * Este arquivo, o prompt.ts e o dados/catalogo.json sao os unicos tres que mudam
 * de um nicho para outro. Todo o resto do src/ atravessa sem tocar.
 */

export interface Servico {
  servico: string;
  categoria: string;
  duracaoMin: number;
  preco: number;
  profissionais: string[];
  disponivel: boolean;
  destaque: boolean;
}

// ---------------------------------------------------------------------------
// Catalogo -- lido de dados/catalogo.json e editavel pelo painel sem reiniciar
// ---------------------------------------------------------------------------

const arquivoCatalogo = () => path.join(dadosDir, "catalogo.json");

let TODOS: Servico[] = [];
/** So o que esta ativo chega ao modelo. */
let SERVICOS: Servico[] = [];

/** Valida e normaliza. Lanca erro com mensagem legivel para o painel. */
export function validarCatalogo(bruto: unknown): Servico[] {
  if (!Array.isArray(bruto)) throw new Error("O catalogo precisa ser uma lista de servicos.");
  return bruto.map((item, i) => {
    const s = item as Partial<Servico> & { profissionais?: unknown };
    const linha = `Servico ${i + 1}`;
    const nome = String(s.servico ?? "").trim();
    if (!nome) throw new Error(`${linha}: nome vazio.`);
    const preco = Number(s.preco);
    if (!Number.isFinite(preco) || preco < 0) throw new Error(`${linha} (${nome}): preco invalido.`);
    const dur = Number(s.duracaoMin);
    if (!Number.isFinite(dur) || dur <= 0) throw new Error(`${linha} (${nome}): duracao invalida.`);
    const profs = Array.isArray(s.profissionais)
      ? s.profissionais
      : String(s.profissionais ?? "").split(",");
    return {
      servico: nome,
      categoria: String(s.categoria ?? "outros").trim().toLowerCase() || "outros",
      duracaoMin: Math.round(dur),
      preco,
      profissionais: profs.map((p) => String(p).trim()).filter(Boolean),
      disponivel: s.disponivel !== false,
      destaque: s.destaque === true,
    };
  });
}

export function carregarCatalogo(): void {
  try {
    TODOS = validarCatalogo(JSON.parse(fs.readFileSync(arquivoCatalogo(), "utf8")));
  } catch (e) {
    console.error("[catalogo] nao consegui ler dados/catalogo.json:", (e as Error).message);
    TODOS = [];
  }
  SERVICOS = TODOS.filter((s) => s.disponivel);
  console.log(`[catalogo] ${SERVICOS.length} servico(s) ativo(s)`);
}

export function catalogoCompleto(): Servico[] {
  return TODOS;
}

export function salvarCatalogo(bruto: unknown): Servico[] {
  const validado = validarCatalogo(bruto);
  fs.mkdirSync(dadosDir, { recursive: true });
  fs.writeFileSync(arquivoCatalogo(), JSON.stringify(validado, null, 2), "utf8");
  carregarCatalogo();
  return validado;
}

carregarCatalogo();

/** Que categorias existem no catalogo agora (cabelo, barba, combo...). */
export function categoriasDisponiveis(): string[] {
  return [...new Set(SERVICOS.map((s) => s.categoria))];
}

/** Os barbeiros que aparecem em algum servico ativo. */
export function barbeirosDisponiveis(): string[] {
  return [...new Set(SERVICOS.flatMap((s) => s.profissionais))];
}

/**
 * A pergunta que o `npm run check` usa para testar function calling.
 *
 * Sai do proprio catalogo: pergunta fixa vira mentira assim que o catalogo muda.
 */
export function exemploDeBusca(): string {
  const s = SERVICOS[0];
  return s ? `Quanto custa o ${s.servico.toLowerCase()}?` : "Quanto custa?";
}

// ---------------------------------------------------------------------------
// Busca
// ---------------------------------------------------------------------------

/**
 * Os campos que participam da busca, em ordem de especificidade.
 *
 * Quem diz "corte degrade" quer o degrade: o nome do servico pesa mais que a
 * categoria. Categoria sozinha ainda passa ("faz barba?"), e com varios servicos
 * na mesma categoria o empate vira pergunta.
 */
function camposDe(s: Servico): Campo[] {
  return [
    { valor: s.servico, peso: 6, pesoExato: 10, colado: true },
    { valor: s.categoria, peso: 5 },
    // pesoExato travado em 3: barbeiro com um servico so casaria "exato" (3+4)
    // e passaria do limiar sozinho, devolvendo um servico que ninguem pediu.
    { valor: s.profissionais.join(" "), peso: 3, pesoExato: 3 },
  ];
}

// Igual ao peso de "categoria contem": categoria sozinha passa raspando, de
// proposito. Barbeiro sozinho (peso 3) nao passa. Mexeu nos pesos, confira aqui.
const LIMIAR = 5;

/** Ficha completa -- so depois que o cliente escolheu um. */
function ficha(s: Servico) {
  return {
    servico: s.servico,
    preco: moeda(s.preco),
    duracao: duracao(s.duracaoMin),
    barbeiros: s.profissionais.join(", "),
  };
}

/** Nome + preco, sem detalhe. */
function resumo(s: Servico) {
  return { servico: s.servico, preco: moeda(s.preco) };
}

function porDestaque(a: Servico, b: Servico): number {
  return Number(b.destaque) - Number(a.destaque) || a.preco - b.preco;
}

function sugestoes(): string[] {
  return SERVICOS.slice().sort(porDestaque).slice(0, 3).map((s) => s.servico);
}

function buscarServico(args: Record<string, unknown>) {
  const termo = typeof args.termo === "string" ? args.termo : "";
  if (!termo.trim()) {
    return {
      encontrado: false,
      instrucao: "Termo vazio. Pergunte qual servico o cliente quer.",
      sugestoes: sugestoes(),
    };
  }

  const { melhor, empatados } = ranquear(SERVICOS, termo, camposDe, LIMIAR);

  if (!melhor) {
    return {
      encontrado: false,
      instrucao:
        "A barbearia nao faz esse servico. Diga que nao tem e ofereca as sugestoes. Nao invente servico nem preco.",
      sugestoes: sugestoes(),
    };
  }

  // Empate tecnico ("barba" casa com Barba e Pigmentacao) -> pergunta qual.
  if (empatados.length > 1) {
    return {
      encontrado: true,
      ambiguo: true,
      instrucao:
        "Mais de um servico bate. Cite no maximo 2 com o preco e pergunte qual o cliente quer.",
      opcoes: empatados.slice(0, 3).map(resumo),
      total: empatados.length,
    };
  }

  return {
    encontrado: true,
    ...ficha(melhor),
    instrucao:
      "Passe o preco exatamente como veio. Se o cliente ainda nao disse o dia, pergunte que dia fica bom pra ele.",
  };
}

function listarServicos(args: Record<string, unknown>) {
  const categoria =
    typeof args.categoria === "string" && args.categoria.trim()
      ? args.categoria.trim().toLowerCase()
      : undefined;

  const filtrados = SERVICOS.filter((s) => !categoria || s.categoria === categoria).sort(
    porDestaque
  );

  if (filtrados.length === 0) {
    return {
      total: 0,
      servicos: [],
      instrucao: "Nada nessa categoria. Diga isso e ofereca o corte ou o combo.",
      categorias: categoriasDisponiveis(),
    };
  }

  // Cliente pediu a lista completa com todas as letras: entrega tudo, um por linha.
  if (args.todos === true || args.todos === "true") {
    return {
      total: filtrados.length,
      servicos: filtrados.map(resumo),
      instrucao:
        "O cliente pediu a lista completa. Mande TODOS, um por linha no formato 'Servico - R$ X (Y min)', " +
        "sem marcador nem negrito, e no fim pergunte qual deles ele quer.",
    };
  }

  // Devolve poucos de proposito: o agente cita no maximo 2, e `total` deixa ele
  // dizer "fazemos 8 servicos" sem recitar os 8.
  const amostra = filtrados.slice(0, 3);

  return {
    total: filtrados.length,
    mostrando: amostra.length,
    servicos: amostra.map(resumo),
    instrucao:
      filtrados.length > 2
        ? `Ha ${filtrados.length} servicos. Cite no maximo 2 e pergunte se ele quer so cabelo, so barba ou os dois. Nao liste todos.`
        : "Pode citar os dois.",
  };
}

// ---------------------------------------------------------------------------
// Horarios (Google Agenda)
// ---------------------------------------------------------------------------

/** Duracao do servico pela tabela. Sem match unico, usa o intervalo do expediente. */
function duracaoDoServico(falado: string): number {
  const { melhor, empatados } = ranquear(SERVICOS, falado, camposDe, LIMIAR);
  if (melhor && empatados.length === 1) return melhor.duracaoMin;
  return Math.max(15, Number(config.intervaloMin) || 30);
}

type Periodo = "manha" | "tarde" | "noite" | "";

function lerPeriodo(v: unknown): Periodo {
  const t = normalizar(String(v ?? ""));
  if (t.includes("manh")) return "manha";
  if (t.includes("tarde")) return "tarde";
  if (t.includes("noit")) return "noite";
  return "";
}

function noPeriodo(hhmm: string, p: Periodo): boolean {
  if (!p) return true;
  const h = Number(hhmm.slice(0, 2));
  if (p === "manha") return h < 12;
  if (p === "tarde") return h >= 12 && h < 18;
  return h >= 18;
}

/** No maximo k horarios espalhados pelo dia: 09:00, 11:30, 14:00, 17:30 -- nao 09:00, 09:30, 10:00. */
function espalhar(lista: string[], k = 4): string[] {
  if (lista.length <= k) return lista;
  return Array.from({ length: k }, (_, i) => lista[Math.round((i * (lista.length - 1)) / (k - 1))]!);
}

/** Proximos dias (a partir de `de`) com vaga no periodo pedido. */
async function proximasVagas(de: string, duracao: number, periodo: Periodo, dias = 2) {
  const achados: { dia: string; data: string; horarios: string[] }[] = [];
  for (let i = 0; i < 14 && achados.length < dias; i++) {
    const d = somarDias(de, i);
    if (!abertoNoDia(d)) continue;
    const livres = (await horariosLivres(d, duracao)).filter((h) => noPeriodo(h, periodo));
    if (livres.length) achados.push({ dia: rotuloDia(d), data: d, horarios: espalhar(livres, 3) });
  }
  return achados;
}

const INSTRUCAO_OFERTA =
  "Ofereca no maximo 3 desses horarios, numa frase curta. Nunca ofereca horario que nao esta na lista. " +
  "Quando o cliente escolher, guarde a data (campo data) e o horario: ao registrar passe dataHora = 'AAAA-MM-DDTHH:MM'.";

async function consultarHorarios(args: Record<string, unknown>) {
  if (!agendaConfigurada()) {
    return {
      agendaConectada: false,
      instrucao:
        "A agenda nao esta conectada. Pergunte o dia e o horario de preferencia e diga que o barbeiro confirma.",
    };
  }

  const duracao = duracaoDoServico(String(args.servico ?? ""));
  const periodo = lerPeriodo(args.periodo);
  const hoje = hojeISO();
  const pedida = dataValida(args.data) ? args.data : undefined;

  if (pedida && pedida < hoje) {
    return { erro: "Essa data ja passou.", instrucao: "Use a lista de proximos dias do seu contexto e consulte de novo." };
  }
  if (pedida && pedida > somarDias(hoje, 60)) {
    return { erro: "Data muito distante.", instrucao: "Diga que a agenda abre ate 60 dias e pergunte uma data mais proxima." };
  }

  if (pedida) {
    if (!abertoNoDia(pedida)) {
      return {
        fechado: true,
        dia: rotuloDia(pedida),
        alternativas: await proximasVagas(somarDias(pedida, 1), duracao, periodo),
        instrucao: "A barbearia nao abre nesse dia. Diga isso e ofereca as alternativas. " + INSTRUCAO_OFERTA,
      };
    }
    const doDia = await horariosLivres(pedida, duracao);
    const noPeriodoPedido = doDia.filter((h) => noPeriodo(h, periodo));
    if (noPeriodoPedido.length) {
      return {
        dia: rotuloDia(pedida),
        data: pedida,
        duracao: `${duracao} min`,
        horarios: espalhar(noPeriodoPedido),
        totalLivres: noPeriodoPedido.length,
        instrucao: INSTRUCAO_OFERTA,
      };
    }
    // Nada no periodo: outro periodo do mesmo dia vale mais que outro dia.
    return {
      semVaga: true,
      dia: rotuloDia(pedida),
      data: pedida,
      outrosHorariosNoDia: periodo ? espalhar(doDia, 3) : [],
      alternativas: await proximasVagas(somarDias(pedida, 1), duracao, periodo),
      instrucao:
        "Nao tem vaga no que o cliente pediu. Diga isso sem rodeio e ofereca outro horario do mesmo dia " +
        "(se houver) ou o dia alternativo. " + INSTRUCAO_OFERTA,
    };
  }

  // Sem data: os proximos dias com vaga.
  const vagas = await proximasVagas(hoje, duracao, periodo);
  return {
    proximasVagas: vagas,
    instrucao: vagas.length
      ? "O cliente nao disse o dia. Ofereca o primeiro dia com vaga e no maximo 3 horarios. " + INSTRUCAO_OFERTA
      : "Agenda cheia nos proximos 14 dias. Diga que o barbeiro vai ver um encaixe e registre sem horario.",
  };
}

// ---------------------------------------------------------------------------
// Lead
// ---------------------------------------------------------------------------

/**
 * `type` e nao `interface` de proposito: um type alias de objeto e atribuivel a
 * Record<string, unknown>, o que deixa este Lead entrar direto no store generico
 * e no webhook, sem cast nenhum. Interface nao e.
 */
export type Lead = {
  nome: string;
  servico: string;
  /** Dia + data + horario/periodo, legivel. */
  diaHorario: string;
  barbeiro: string;
  jaCliente: string;
  /** "AAAA-MM-DDTHH:MM" no fuso da barbearia, quando o horario e exato. */
  dataHora?: string;
  /** Evento criado na Google Agenda (para alterar em vez de duplicar). */
  eventoId?: string;
  agenda?: string;
  agendaLink?: string;
};

/** Conversas simuladas no painel ou no terminal. */
export function ehConversaDeTeste(chatid: string): boolean {
  return chatid.startsWith("teste-") || chatid.startsWith("repl-");
}

/**
 * Telefone legivel a partir do jid.
 * "5511999998888@s.whatsapp.net" -> "5511999998888". Contatos com id privado
 * ("@lid") nao expoem o numero: o barbeiro responde pela propria conversa.
 */
export function telefoneDe(chatid: string): string {
  if (chatid.endsWith("@lid")) return "id privado (responda pela conversa no WhatsApp)";
  return chatid.split("@")[0] ?? chatid;
}

/** O texto que chega no WhatsApp de quem vai atender. */
function formatarParaHumano(lead: Lead, telefoneCliente: string, naAgenda: boolean): string {
  const linhas = [
    naAgenda ? "*Novo horário marcado* 📅" : "*Pedido de horário*",
    "",
    `Cliente: ${lead.nome}`,
    `WhatsApp: ${telefoneCliente}`,
    `Serviço: ${lead.servico}`,
    `Quando: ${lead.diaHorario}`,
    `Barbeiro: ${lead.barbeiro}`,
    `Já é cliente: ${lead.jaCliente}`,
  ];
  if (lead.agenda) linhas.push(`Agenda: ${lead.agenda}`);
  linhas.push(
    "",
    naAgenda
      ? "Já está na Google Agenda. Se precisar mudar, fale com o cliente e ajuste o evento."
      : "Confirme o horário na agenda e assuma a conversa."
  );
  return linhas.join("\n");
}

/** O nome oficial da tabela: "corte e barba" vira "Combo corte e barba". */
function nomeOficial(falado: string): string {
  const { melhor, empatados } = ranquear(SERVICOS, falado, camposDe, LIMIAR);
  return melhor && empatados.length === 1 ? melhor.servico : falado;
}

/** "2026-11-14T10:00" -> { data, hora }. Aceita "10h", segundos e espaco no lugar do T. */
function lerDataHora(v: unknown): { data: string; hora: string } | undefined {
  const m = String(v ?? "").trim().match(/^(\d{4}-\d{2}-\d{2})[T ](\d{1,2})(?::|h)?(\d{2})?/);
  if (!m || !dataValida(m[1])) return undefined;
  const h = Number(m[2]);
  const min = Number(m[3] ?? 0);
  if (h > 23 || min > 59) return undefined;
  return { data: m[1]!, hora: `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}` };
}

/**
 * Conversas em que o registro ja foi barrado uma vez por falta de dado.
 *
 * O prompt manda perguntar barbeiro e "ja e cliente" antes de registrar, mas nos
 * testes o modelo registrou assim que ouviu o dia -- e as respostas que vieram
 * depois cairam no vazio (o agente ja estava pausado). A primeira tentativa
 * incompleta volta com o que falta; a segunda passa de qualquer jeito, para nao
 * prender o cliente que nao quer responder.
 */
const jaCobrado = new Set<string>();

export function esquecerCobranca(chatid: string): void {
  jaCobrado.delete(chatid);
}

function faltando(args: Record<string, unknown>): string[] {
  const vazio = (v: unknown) => !String(v ?? "").trim();
  const falta: string[] = [];
  if (agendaConfigurada()) {
    if (!lerDataHora(args.dataHora)) {
      falta.push("horario exato (use consultarHorarios, ofereca horarios livres e passe dataHora)");
    }
  } else if (vazio(args.diaHorario)) {
    falta.push("dia e horario");
  }
  if (vazio(args.barbeiro)) falta.push("barbeiro de preferencia");
  if (vazio(args.jaCliente)) falta.push("se ja e cliente");
  return falta;
}

async function registrarLead(args: Record<string, unknown>, chatid: string) {
  const anterior = leadAnterior<Lead>(chatid);

  if (!anterior && !jaCobrado.has(chatid)) {
    const falta = faltando(args);
    if (falta.length > 0) {
      jaCobrado.add(chatid);
      return {
        ok: false,
        instrucao:
          `NAO registrado ainda. Falta: ${falta.join(", ")}. Pergunte o primeiro que falta ` +
          "(uma pergunta so) e chame registrarLead de novo depois que ele responder. " +
          "Se o cliente ja respondeu isso nesta conversa, chame de novo agora passando o que ele disse.",
      };
    }
  }

  const lead: Lead = {
    nome: preferir(String(args.nome ?? ""), anterior?.nome, "nao informado"),
    servico: preferir(nomeOficial(String(args.servico ?? "")), anterior?.servico, "nao informado"),
    diaHorario: preferir(String(args.diaHorario ?? ""), anterior?.diaHorario, "nao agendado"),
    barbeiro: preferir(String(args.barbeiro ?? ""), anterior?.barbeiro, "sem preferencia"),
    jaCliente: preferir(String(args.jaCliente ?? ""), anterior?.jaCliente, "nao informado"),
    eventoId: anterior?.eventoId,
    agenda: anterior?.agenda,
    agendaLink: anterior?.agendaLink,
  };

  const teste = ehConversaDeTeste(chatid);
  const telefone = telefoneDe(chatid);
  const dh = lerDataHora(args.dataHora) ?? lerDataHora(anterior?.dataHora);
  let naAgenda = false;

  if (dh) {
    lead.dataHora = `${dh.data}T${dh.hora}`;
    // O texto legivel sai da data real, nao do que o modelo escreveu.
    lead.diaHorario = `${rotuloDia(dh.data)}, ${dh.hora}`;
  }

  // --- Google Agenda ---
  if (dh && agendaConfigurada()) {
    const duracao = duracaoDoServico(lead.servico);
    try {
      // O cliente pode ter demorado a responder: confere de novo antes de gravar.
      if (!(await horarioLivre(dh.data, dh.hora, duracao, lead.eventoId))) {
        return {
          ok: false,
          ocupado: true,
          instrucao:
            "Esse horario nao esta mais livre (ou esta fora do expediente). NAO registrado. " +
            "Chame consultarHorarios para essa data e ofereca outros horarios ao cliente.",
        };
      }
      if (teste) {
        // Simulador do painel: confere a agenda de verdade, mas nao grava nada nela.
        lead.agenda = "teste: horario livre, evento NAO criado";
      } else {
        const comBarbeiro =
          lead.barbeiro && !/tanto faz|sem prefer/i.test(lead.barbeiro) ? ` (${lead.barbeiro})` : "";
        const evento = {
          dataISO: dh.data,
          hhmm: dh.hora,
          duracaoMin: duracao,
          titulo: `${lead.servico} - ${lead.nome}${comBarbeiro}`,
          descricao: [
            `Cliente: ${lead.nome}`,
            `WhatsApp: ${telefone}`,
            `Serviço: ${lead.servico}`,
            `Barbeiro: ${lead.barbeiro}`,
            `Já é cliente: ${lead.jaCliente}`,
            "",
            `Agendado pelo atendente virtual em ${new Date().toLocaleString("pt-BR", { timeZone: config.timezone })}.`,
          ].join("\n"),
        };
        const r = lead.eventoId ? await alterarEvento(lead.eventoId, evento) : await criarEvento(evento);
        lead.eventoId = r.id;
        lead.agendaLink = r.link;
        lead.agenda = "✅ na Google Agenda";
        naAgenda = true;
      }
    } catch (e) {
      // Agenda fora do ar NAO perde o pedido: segue para o WhatsApp e para o painel.
      const motivo = e instanceof Error ? e.message : String(e);
      console.error("[agenda] falhou ao criar evento:", motivo);
      lead.agenda = `⚠️ não entrou na agenda (${motivo.slice(0, 120)})`;
    }
  }

  guardarLead(chatid, lead);
  const registradoEm = new Date().toISOString();

  const titulo = anterior ? "PEDIDO ATUALIZADO" : "NOVO PEDIDO";
  console.log(
    `\n===== ${titulo}${teste ? " (teste)" : ""} =====\n` +
      JSON.stringify({ ...lead, telefone, registradoEm }, null, 2) +
      "\n============================\n"
  );
  salvarPedido({
    nome: lead.nome,
    servico: lead.servico,
    diaHorario: lead.diaHorario,
    barbeiro: lead.barbeiro,
    jaCliente: lead.jaCliente,
    dataHora: lead.dataHora,
    agenda: lead.agenda,
    agendaLink: lead.agendaLink,
    telefone,
    registradoEm,
    atualizado: !!anterior,
    teste,
  });

  // Conversa de teste (painel / terminal) nao incomoda o barbeiro.
  if (!teste) {
    const { eventoId: _id, ...paraFora } = lead;
    notificarLead(paraFora, formatarParaHumano(lead, telefone, naAgenda), chatid);
  }

  const reservado = naAgenda || (teste && !!lead.agenda?.startsWith("teste"));
  const minInatividade = minutos(config.inatividadeMin, 5);

  if (reservado) {
    // Entrou na agenda: o atendimento continua (o cliente pode ter mais duvidas).
    // A partir daqui vale o encerramento por inatividade.
    marcarPosReserva(chatid);
  } else if (config.pausarAposLead && !teste) {
    // Nao entrou na agenda: o barbeiro assume a conversa e o agente sai da frente.
    pausar(chatid, config.pausaAposLeadMin * 60_000, "pedido sem agenda, barbeiro assume");
  }

  if (anterior) {
    return {
      ok: true,
      jaRegistrado: true,
      instrucao:
        "Esse pedido JA estava registrado e foi atualizado" +
        (naAgenda ? " (o horario na agenda tambem)" : "") +
        ". NAO registre de novo. Confirme a mudanca e pergunte se ele precisa de mais alguma coisa.",
    };
  }

  return {
    ok: true,
    reservado,
    instrucao: reservado
      ? `Horario reservado: ${lead.diaHorario}. Na MESMA mensagem: confirme em uma frase (servico, dia e hora) ` +
        `e pergunte se ele deseja mais alguma informacao, avisando que, sem resposta, o atendimento e encerrado ` +
        `em ${minInatividade} minutos. Ex: "Fechado: degradê sábado às 9h, já está na agenda. Precisa de mais ` +
        `alguma informação? Se eu não tiver retorno em ${minInatividade} minutos, encerro o atendimento por aqui."`
      : "Pedido registrado. Avise que o barbeiro confirma o horario com ele em instantes. Nao pergunte mais nada.",
  };
}

/**
 * O cliente disse que nao precisa de mais nada. O sistema manda a despedida fixa
 * (editavel no painel) e so fecha a sessao se ele ficar o prazo sem escrever --
 * um "nao" ambiguo nao derruba mais a conversa de quem ainda tinha pergunta.
 */
function encerrarAtendimento(_args: Record<string, unknown>, chatid: string) {
  marcarEncerrar(chatid);
  return {
    ok: true,
    instrucao:
      "O sistema vai mandar a mensagem de despedida padrao. Responda apenas 'ok' -- esse texto nao e enviado.",
  };
}

// ---------------------------------------------------------------------------
// Declaracoes para o Gemini
// ---------------------------------------------------------------------------

/** Montado a cada turno: as categorias mudam quando o catalogo e editado no painel. */
export function declaracoes(): FunctionDeclaration[] {
  const categorias = categoriasDisponiveis();
  return [
  {
    name: "buscarServico",
    description:
      "Busca um servico da barbearia pelo nome ou tipo (corte, degrade, barba, sobrancelha...). Use sempre que o cliente citar um servico ou perguntar preco. Unica fonte de preco valida.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        termo: {
          type: "string",
          description: "O que o cliente falou. Ex: 'degrade', 'barba', 'corte e barba', 'platinado'.",
        },
      },
      required: ["termo"],
    },
  },
  {
    name: "listarServicos",
    description:
      "Mostra servicos com o total disponivel. Use quando o cliente nao souber o que quer ou pedir a tabela. " +
      "Por padrao retorna poucos itens: cite no maximo 2. Se o cliente pedir explicitamente TODOS os servicos, " +
      "a tabela completa ou a lista inteira, passe todos=true.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        todos: {
          type: "boolean",
          description: "true so quando o cliente pediu a lista/tabela completa ('todos os servicos', 'manda a tabela').",
        },
        categoria: {
          type: "string",
          ...(categorias.length ? { enum: categorias } : {}),
          description: "Filtro opcional. Omita para trazer todos.",
        },
      },
    },
  },
  {
    name: "registrarLead",
    description:
      "Registra o pedido de horario e passa para o barbeiro confirmar. Chame quando tiver o servico e ja tiver perguntado dia/horario e barbeiro de preferencia e ouvido a resposta.",
    parametersJsonSchema: {
      type: "object",
      properties: {
        nome: { type: "string", description: "Nome do cliente." },
        servico: { type: "string", description: "Servico que ele quer fazer." },
        diaHorario: {
          type: "string",
          description:
            "Dia da semana + DATA + horario ou periodo que o CLIENTE aceitou. " +
            "SEMPRE com a data concreta, no formato 'sabado DD/MM, 10h' ou 'sexta-feira DD/MM, fim da tarde', com a data real. " +
            "Converta 'amanha'/'sabado' usando a lista de proximos dias do seu contexto. " +
            "Omita se ele nao quis marcar ou nao respondeu. NUNCA preencha com o horario que voce " +
            "sugeriu sem ele ter aceitado.",
        },
        barbeiro: {
          type: "string",
          description:
            "Barbeiro que o cliente prefere. Se ele disse que tanto faz, passe 'tanto faz'. Omita so se ainda nao perguntou.",
        },
        jaCliente: {
          type: "string",
          description: "'sim' se ja cortou aqui antes, 'nao' se e a primeira vez. Omita se nao souber.",
        },
        ...(agendaConfigurada()
          ? {
              dataHora: {
                type: "string",
                description:
                  "Horario exato que o CLIENTE escolheu entre os que consultarHorarios devolveu, no formato " +
                  "'AAAA-MM-DDTHH:MM' (ex: '2026-11-14T10:00'). Use a data do campo `data` da ferramenta. " +
                  "Omita se ele nao quis marcar agora.",
              },
            }
          : {}),
      },
      required: ["nome", "servico"],
    },
  },
  {
    name: "encerrarAtendimento",
    description:
      "Despede-se do cliente. Use quando voce perguntou se ele precisa de mais alguma coisa e ele disse " +
      "que nao (ex: 'nao', 'nao, obrigado', 'so isso', 'valeu', 'era so isso'). Nao use se ele fez outra " +
      "pergunta na mesma mensagem: responda a pergunta.",
    parametersJsonSchema: { type: "object", properties: {} },
  },
  ...(agendaConfigurada()
    ? [
        {
          name: "consultarHorarios",
          description:
            "Consulta a agenda da barbearia e devolve os horarios LIVRES. Use sempre antes de oferecer ou " +
            "aceitar um horario. Unica fonte valida de horario disponivel.",
          parametersJsonSchema: {
            type: "object",
            properties: {
              data: {
                type: "string",
                description:
                  "Dia pedido no formato AAAA-MM-DD, convertido pela lista de proximos dias do seu contexto " +
                  "('sabado' -> data do proximo sabado). Omita se o cliente ainda nao disse o dia.",
              },
              periodo: {
                type: "string",
                enum: ["manha", "tarde", "noite"],
                description: "Periodo que o cliente prefere, se ele disse. Omita se nao disse.",
              },
              servico: {
                type: "string",
                description: "Servico escolhido, para calcular a duracao. Ex: 'corte degrade'.",
              },
            },
          },
        } as FunctionDeclaration,
      ]
    : []),
  ];
}

export const handlers: Record<string, Handler> = {
  buscarServico,
  listarServicos,
  consultarHorarios,
  registrarLead,
  encerrarAtendimento,
};
