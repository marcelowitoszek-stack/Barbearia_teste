import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Configuracao em duas camadas:
 *
 * 1. `.env` -- gerado pelo instalador. Segredos de infraestrutura (chave da
 *    Evolution, segredo do webhook) e os valores iniciais do negocio.
 * 2. `dados/configuracoes.json` -- o que o dono edita pelo painel
 *    (http://localhost:3737). Sobrepoe o .env e vale na hora, sem reiniciar.
 *
 * Assim o barbeiro nunca precisa abrir arquivo nenhum: instala, abre o painel,
 * preenche e le o QR Code.
 */

function opt(nome: string, padrao: string): string {
  const v = process.env[nome];
  return v && v.trim() ? v.trim() : padrao;
}

function bool(nome: string, padrao: boolean): boolean {
  const v = process.env[nome]?.trim().toLowerCase();
  if (!v) return padrao;
  return v === "true" || v === "1" || v === "sim";
}

function num(nome: string, padrao: number): number {
  const v = process.env[nome];
  if (!v || !v.trim()) return padrao;
  const n = Number(v);
  return Number.isFinite(n) ? n : padrao;
}

export const dadosDir = path.resolve(opt("DADOS_DIR", path.join(process.cwd(), "dados")));

export const config = {
  // Fora do Docker (npm run dev) usa 3747 para nao disputar a 3737 do painel instalado.
  porta: num("PORT", 3747),

  // --- identidade do negocio (editavel no painel) ---
  empresaNome: opt("EMPRESA_NOME", "Minha Barbearia"),
  empresaCidade: opt("EMPRESA_CIDADE", ""),
  atendenteNome: opt("ATENDENTE_NOME", "Alex"),
  /**
   * Endereco e horario entram no prompt SO se preenchidos.
   * Vazio e melhor que errado: horario inventado manda o cliente na porta fechada.
   */
  empresaEndereco: opt("EMPRESA_ENDERECO", ""),
  empresaHorario: opt("EMPRESA_HORARIO", ""),
  /** WhatsApp de quem recebe o pedido pronto (ex: 5511999998888). */
  humanoWhatsapp: opt("HUMANO_WHATSAPP", ""),
  /** Liga/desliga o atendimento automatico sem parar o sistema. */
  agenteAtivo: bool("AGENTE_ATIVO", true),

  /** Fuso do negocio. Container roda em UTC -- sem isso o agente erra o dia. */
  timezone: opt("TIMEZONE", "America/Sao_Paulo"),

  // --- Google Agenda (editavel no painel) ---
  // A chave da conta de servico e qualquer .json com "type":"service_account"
  // dentro da pasta dados/. O ID da agenda costuma ser o e-mail do dono.
  agendaId: opt("AGENDA_ID", ""),
  /** Expediente usado para calcular horarios livres. "HH:MM". */
  horaAbertura: opt("HORA_ABERTURA", "09:00"),
  horaFechamento: opt("HORA_FECHAMENTO", "19:00"),
  /** Pausa (ex: almoco). Vazio = sem pausa. */
  almocoInicio: opt("ALMOCO_INICIO", ""),
  almocoFim: opt("ALMOCO_FIM", ""),
  /** Dias abertos: 0=domingo ... 6=sabado, separados por virgula. */
  diasFuncionamento: opt("DIAS_FUNCIONAMENTO", "1,2,3,4,5,6"),
  /** De quanto em quanto tempo oferecer horario (min). */
  intervaloMin: opt("INTERVALO_MIN", "30"),
  /** Quantos clientes podem ser atendidos ao mesmo tempo (cadeiras/barbeiros). */
  atendimentosSimultaneos: opt("ATENDIMENTOS_SIMULTANEOS", "1"),
  /** Nao oferece horario que comece antes de agora + isto (min). */
  antecedenciaMin: opt("ANTECEDENCIA_MIN", "60"),

  // --- Gemini ---
  geminiApiKey: opt("GEMINI_API_KEY", ""),
  // O Google aposenta model id de tempos em tempos. `npm run check` avisa.
  geminiModel: opt("GEMINI_MODEL", "gemini-3.5-flash-lite"),
  temperatura: num("TEMPERATURA", 0.7),
  maxOutputTokens: num("MAX_OUTPUT_TOKENS", 400),
  fraseFallback: opt("FRASE_FALLBACK", "Deixa eu confirmar isso aqui e já te falo 👍"),

  // --- Evolution API (WhatsApp gratuito, roda nesta maquina) ---
  evolutionUrl: opt("EVOLUTION_URL", "http://localhost:8787").replace(/\/+$/, ""),
  evolutionApiKey: opt("EVOLUTION_API_KEY", ""),
  evolutionInstancia: opt("EVOLUTION_INSTANCIA", "barbearia"),
  /** Endereco pelo qual a Evolution enxerga o agente (rede interna do Docker). */
  webhookUrlInterna: opt("WEBHOOK_URL_INTERNA", "http://agente:3000/webhook"),
  /** Segredo do webhook. O instalador gera um aleatorio. */
  webhookSecret: opt("WEBHOOK_SECRET", ""),

  // --- entrega do lead ---
  /** POST do pedido em JSON (n8n, Make, Zapier, planilha...). Vazio = desligado. */
  leadWebhookUrl: opt("LEAD_WEBHOOK_URL", ""),

  // --- handoff ---
  /** Pausa depois de pedido que NAO entrou na agenda (o barbeiro assume). */
  pausarAposLead: bool("PAUSAR_APOS_LEAD", true),
  pausaAposLeadMin: num("PAUSA_APOS_LEAD_MIN", 120),
  /**
   * Celular particular: quando voce manda mensagem pelo celular (para cliente,
   * familia, quem for), o atendente virtual fica fora daquela conversa por este
   * tempo, renovado a cada mensagem sua. Tambem vale para quem escolhe a opcao 3.
   * Em minutos, como texto (editavel no painel). Padrao: 3 horas.
   */
  pausaHumanoMin: opt("PAUSA_HUMANO_MIN", "180"),
  /** Depois de reservar na agenda: sem resposta do cliente por isto, encerra a sessao. */
  inatividadeMin: opt("INATIVIDADE_MIN", "5"),
  /**
   * Cliente disse que nao precisa de mais nada: recebe a despedida e a sessao
   * so fecha se ele ficar este tempo sem escrever. Se escrever antes, segue normal.
   */
  despedidaMin: opt("DESPEDIDA_MIN", "1"),
  /** Etiqueta do WhatsApp Business cujos contatos o atendente nunca responde. */
  vipEtiqueta: opt("VIP_ETIQUETA", "Clientes VIP"),

  // --- mensagens fixas (editaveis no painel) ---
  mensagemBoasVindas: opt(
    "MENSAGEM_BOAS_VINDAS",
    "Olá seja bem vindo, você está conversando com o atendente virtual Zé Mané, eu vou te guiar por aqui.\n" +
      "Para seguir o atendimento digite 2 ou digite 3 para ser atendido por um Atendimento humanizado."
  ),
  mensagemOpcaoInvalida: opt(
    "MENSAGEM_OPCAO_INVALIDA",
    "Não entendi 🙂 Digite 2 para seguir com o atendimento virtual ou 3 para falar com uma pessoa da nossa equipe."
  ),
  mensagemHumano: opt(
    "MENSAGEM_HUMANO",
    "Certo! Já avisei a nossa equipe e uma pessoa vai continuar o seu atendimento por aqui em breve. 🙂"
  ),
  mensagemDespedida: opt(
    "MENSAGEM_DESPEDIDA",
    'Tudo bem!\nSe precisar de mais alguma coisa, digite "Oi" e inicie uma nova conversa! Obrigado!🤝'
  ),
  mensagemEncerramento: opt(
    "MENSAGEM_ENCERRAMENTO",
    "Como não tivemos retorno por aqui, este atendimento foi encerrado por inatividade. 🙂\n\n" +
      "Se ainda precisar de ajuda, é só mandar uma mensagem que a gente te atende de novo."
  ),

  // --- comportamento de conversa ---
  /** Junta mensagens picadas ("oi" / "quanto ta" / "o corte") antes de responder. */
  debounceMs: num("DEBOUNCE_MS", 6000),
  /** Entende audio do cliente (o Gemini transcreve). */
  entenderAudio: bool("ENTENDER_AUDIO", true),

  // --- humanizacao do envio ---
  humanizar: bool("HUMANIZAR", true),
  digitandoBaseMs: num("DIGITANDO_BASE_MS", 800),
  digitandoPorCharMs: num("DIGITANDO_POR_CHAR_MS", 25),
  digitandoMaxMs: num("DIGITANDO_MAX_MS", 5000),

  sessaoTtlMs: num("SESSAO_TTL_MS", 2 * 60 * 60 * 1000),
  maxHistorico: num("MAX_HISTORICO", 24),
  maxToolIteracoes: num("MAX_TOOL_ITERACOES", 5),
};

/** Valores originais das mensagens fixas, para restaurar se o painel apagar. */
const PADROES = {
  mensagemBoasVindas: config.mensagemBoasVindas,
  mensagemOpcaoInvalida: config.mensagemOpcaoInvalida,
  mensagemHumano: config.mensagemHumano,
  mensagemEncerramento: config.mensagemEncerramento,
  mensagemDespedida: config.mensagemDespedida,
};

/** Minutos de um campo numerico guardado como texto, com piso. */
export function minutos(valor: string, padrao: number): number {
  const n = Number(valor);
  return Number.isFinite(n) && n > 0 ? n : padrao;
}

// ---------------------------------------------------------------------------
// Camada editavel pelo painel
// ---------------------------------------------------------------------------

/** Campos que o painel pode ler e gravar. */
export const CAMPOS_EDITAVEIS = [
  "empresaNome",
  "empresaCidade",
  "atendenteNome",
  "empresaEndereco",
  "empresaHorario",
  "humanoWhatsapp",
  "agenteAtivo",
  "geminiApiKey",
  "geminiModel",
  "agendaId",
  "horaAbertura",
  "horaFechamento",
  "almocoInicio",
  "almocoFim",
  "diasFuncionamento",
  "intervaloMin",
  "atendimentosSimultaneos",
  "antecedenciaMin",
  "pausaHumanoMin",
  "inatividadeMin",
  "despedidaMin",
  "vipEtiqueta",
  "mensagemBoasVindas",
  "mensagemOpcaoInvalida",
  "mensagemHumano",
  "mensagemEncerramento",
  "mensagemDespedida",
] as const;

export type CampoEditavel = (typeof CAMPOS_EDITAVEIS)[number];

const arquivoConfig = () => path.join(dadosDir, "configuracoes.json");

/** Aplica dados/configuracoes.json por cima do .env. Chamado no boot. */
export function carregarConfiguracoes(): void {
  try {
    const bruto = JSON.parse(fs.readFileSync(arquivoConfig(), "utf8")) as Record<string, unknown>;
    aplicar(bruto);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn("[config] configuracoes.json invalido, usando o .env:", (e as Error).message);
    }
  }
  aplicar({}); // normaliza o que veio so do .env (telefone etc.)
}

function aplicar(dados: Record<string, unknown>): void {
  const alvo = config as Record<string, unknown>;
  for (const campo of CAMPOS_EDITAVEIS) {
    if (!(campo in dados)) continue;
    const v = dados[campo];
    if (campo === "agenteAtivo") alvo[campo] = v === true || v === "true";
    else if (typeof v === "string" || typeof v === "number") alvo[campo] = String(v).trim();
  }
  // Telefone so com digitos: "(11) 99999-8888" vira "11999998888".
  // Sem o 55 (DDD + numero = 10 ou 11 digitos), completa com o codigo do Brasil.
  config.humanoWhatsapp = config.humanoWhatsapp.replace(/\D/g, "");
  if (/^\d{10,11}$/.test(config.humanoWhatsapp)) config.humanoWhatsapp = `55${config.humanoWhatsapp}`;
  if (!config.geminiModel) config.geminiModel = "gemini-3.5-flash-lite";
  // Mensagem fixa apagada no painel volta ao padrao: cliente nunca recebe mensagem vazia.
  for (const campo of ["mensagemBoasVindas", "mensagemOpcaoInvalida", "mensagemHumano", "mensagemEncerramento", "mensagemDespedida"] as const) {
    if (!config[campo].trim()) config[campo] = PADROES[campo];
  }
}

/** Barra valores de expediente que quebrariam o calculo de horarios. */
function validarExpediente(n: Record<string, unknown>): void {
  const hora = /^([01]?\d|2[0-3]):[0-5]\d$/;
  const nomes: Record<string, string> = {
    horaAbertura: "Abertura",
    horaFechamento: "Fechamento",
    almocoInicio: "Inicio da pausa",
    almocoFim: "Fim da pausa",
  };
  for (const [campo, nome] of Object.entries(nomes)) {
    const v = typeof n[campo] === "string" ? (n[campo] as string).trim() : undefined;
    if (v === undefined) continue;
    const opcional = campo.startsWith("almoco");
    if (!(opcional && v === "") && !hora.test(v)) {
      throw new Error(`${nome}: use o formato HH:MM (ex: 09:00).`);
    }
  }
  const minutos = (h: string) => Number(h.split(":")[0]) * 60 + Number(h.split(":")[1]);
  const ab = String(n.horaAbertura ?? config.horaAbertura);
  const fe = String(n.horaFechamento ?? config.horaFechamento);
  if (hora.test(ab) && hora.test(fe) && minutos(fe) <= minutos(ab)) {
    throw new Error("O fechamento precisa ser depois da abertura.");
  }
  for (const campo of ["intervaloMin", "atendimentosSimultaneos", "antecedenciaMin", "pausaHumanoMin", "inatividadeMin", "despedidaMin"]) {
    if (n[campo] === undefined) continue;
    const v = Number(n[campo]);
    const minimo = campo === "antecedenciaMin" ? 0 : 1;
    if (!Number.isInteger(v) || v < minimo) throw new Error(`Valor invalido em ${campo}.`);
  }
}

/** Grava as alteracoes do painel e aplica na hora. */
export function salvarConfiguracoes(novos: Record<string, unknown>): void {
  // Chave mascarada vinda do painel = "nao mexer".
  if (typeof novos.geminiApiKey === "string" && novos.geminiApiKey.includes("•")) {
    delete novos.geminiApiKey;
  }
  validarExpediente(novos);
  aplicar(novos);
  const gravar: Record<string, unknown> = {};
  for (const campo of CAMPOS_EDITAVEIS) gravar[campo] = config[campo];
  fs.mkdirSync(dadosDir, { recursive: true });
  fs.writeFileSync(arquivoConfig(), JSON.stringify(gravar, null, 2), "utf8");
}

/** Versao segura para mostrar no painel: a chave sai mascarada. */
export function configuracoesPublicas(): Record<string, unknown> {
  const saida: Record<string, unknown> = {};
  for (const campo of CAMPOS_EDITAVEIS) saida[campo] = config[campo];
  const k = config.geminiApiKey;
  saida.geminiApiKey = k ? `${k.slice(0, 4)}••••••••${k.slice(-4)}` : "";
  return saida;
}

export function assertGemini(): void {
  if (!config.geminiApiKey) {
    throw new Error(
      "Chave do Gemini nao configurada. Abra o painel (http://localhost:3737) " +
        "ou preencha GEMINI_API_KEY no .env. Crie a chave em https://aistudio.google.com/apikey"
    );
  }
}

export function assertEvolution(): void {
  if (!config.evolutionUrl || !config.evolutionApiKey) {
    throw new Error("EVOLUTION_URL e EVOLUTION_API_KEY sao obrigatorias. Rode o instalador.");
  }
}

carregarConfiguracoes();
