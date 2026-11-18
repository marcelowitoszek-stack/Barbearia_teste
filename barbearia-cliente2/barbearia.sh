#!/usr/bin/env bash
# Instalador e controle do Atendente de IA da Barbearia (macOS e Linux).
#
#   ./barbearia.sh instalar    primeira vez (pergunta os dados e liga tudo)
#   ./barbearia.sh iniciar     liga de novo
#   ./barbearia.sh parar       desliga
#   ./barbearia.sh logs        mostra o que o atendente esta fazendo
#   ./barbearia.sh atualizar   baixa versoes novas e religa

set -u
cd "$(dirname "$0")"
ACAO="${1:-instalar}"

verde() { printf "\033[32m  [ok] %s\033[0m\n" "$1"; }
amarelo() { printf "\033[33m  [!] %s\033[0m\n" "$1"; }
titulo() { printf "\n\033[36m== %s ==\033[0m\n" "$1"; }
falha() { printf "\n\033[31m  [X] %s\033[0m\n\n" "$1"; exit 1; }

segredo() { LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c "${1:-48}"; }

porta_livre() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

escolher_porta() {
  local p="$1"
  while ! porta_livre "$p"; do p=$((p + 1)); done
  echo "$p"
}

env_valor() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

url_painel() { echo "http://localhost:$(env_valor PAINEL_PORTA || true)" | sed 's/:$/:3737/'; }

abrir() {
  if command -v open >/dev/null 2>&1; then open "$1"
  elif command -v xdg-open >/dev/null 2>&1; then xdg-open "$1" >/dev/null 2>&1 &
  fi
}

garantir_docker() {
  titulo "Verificando o Docker"
  if ! command -v docker >/dev/null 2>&1; then
    if [[ "$(uname)" == "Darwin" ]]; then
      abrir "https://www.docker.com/products/docker-desktop/"
      falha "Instale o Docker Desktop (abriu no navegador), abra-o uma vez e rode de novo."
    else
      amarelo "Docker nao encontrado. Instalando pelo script oficial (pede sua senha)..."
      curl -fsSL https://get.docker.com | sudo sh || falha "Nao consegui instalar o Docker."
      sudo usermod -aG docker "$USER" || true
      amarelo "Docker instalado. Saia e entre de novo na sessao (ou reinicie) e rode este script outra vez."
      exit 0
    fi
  fi
  if ! docker info >/dev/null 2>&1; then
    if [[ "$(uname)" == "Darwin" ]]; then
      amarelo "Abrindo o Docker Desktop..."
      open -a Docker || true
    else
      sudo systemctl start docker 2>/dev/null || true
    fi
    for _ in $(seq 1 48); do
      docker info >/dev/null 2>&1 && break
      printf "  aguardando o Docker ligar...\n"; sleep 5
    done
    docker info >/dev/null 2>&1 || falha "O Docker nao ligou. Abra-o manualmente e rode de novo."
  fi
  docker compose version >/dev/null 2>&1 || falha "Seu Docker nao tem 'docker compose'. Atualize o Docker."
  verde "Docker funcionando"
}

criar_env() {
  titulo "Configuracao inicial"
  echo "  Responda algumas perguntas. Tudo pode ser alterado depois no painel."
  echo "  Chave do Gemini: crie gratis em https://aistudio.google.com/apikey (pode deixar em branco)"
  read -r -p "  Chave do Gemini: " GEMINI
  read -r -p "  Nome da barbearia: " NOME; NOME="${NOME:-Minha Barbearia}"
  read -r -p "  Cidade (opcional): " CIDADE
  read -r -p "  Nome do atendente virtual (Enter = Alex): " ATENDENTE; ATENDENTE="${ATENDENTE:-Alex}"
  read -r -p "  WhatsApp do barbeiro que recebe os pedidos, com 55 e DDD (opcional): " BARBEIRO
  BARBEIRO="$(echo "$BARBEIRO" | tr -cd '0-9')"

  local painel evo
  painel="$(escolher_porta 3737)"; evo="$(escolher_porta 8787)"

  # Sem array associativo: o bash do macOS (3.2) nao tem.
  local K_EVO K_WH K_PG
  K_EVO="$(segredo 48)"; K_WH="$(segredo 48)"; K_PG="$(segredo 32)"

  : > .env
  while IFS= read -r linha || [[ -n "$linha" ]]; do
    linha="${linha%$'\r'}"
    case "$linha" in
      GEMINI_API_KEY=*)    echo "GEMINI_API_KEY=$GEMINI" ;;
      EMPRESA_NOME=*)      echo "EMPRESA_NOME=$NOME" ;;
      EMPRESA_CIDADE=*)    echo "EMPRESA_CIDADE=$CIDADE" ;;
      ATENDENTE_NOME=*)    echo "ATENDENTE_NOME=$ATENDENTE" ;;
      HUMANO_WHATSAPP=*)   echo "HUMANO_WHATSAPP=$BARBEIRO" ;;
      EVOLUTION_API_KEY=*) echo "EVOLUTION_API_KEY=$K_EVO" ;;
      WEBHOOK_SECRET=*)    echo "WEBHOOK_SECRET=$K_WH" ;;
      POSTGRES_SENHA=*)    echo "POSTGRES_SENHA=$K_PG" ;;
      PAINEL_PORTA=*)      echo "PAINEL_PORTA=$painel" ;;
      EVOLUTION_PORTA=*)   echo "EVOLUTION_PORTA=$evo" ;;
      *)                   echo "$linha" ;;
    esac >> .env
  done < .env.example
  chmod 600 .env
  verde "Arquivo .env criado (guarde-o: ele tem as senhas deste computador)"
}

esperar_painel() {
  titulo "Aguardando o sistema ligar"
  local url; url="$(url_painel)"
  for _ in $(seq 1 100); do
    if curl -fs "$url/health" >/dev/null 2>&1; then verde "Sistema no ar"; return 0; fi
    sleep 3; printf "  ...\n"
  done
  amarelo "Demorou mais que o esperado. Veja: ./barbearia.sh logs"
  return 1
}

subir() {
  titulo "Ligando banco, WhatsApp (Evolution) e atendente"
  docker compose up -d "$@" || falha "Nao consegui ligar os servicos. Veja a mensagem acima."
}

case "$ACAO" in
  instalar)
    printf "\n\033[36m  ATENDENTE DE IA DA BARBEARIA - instalacao\033[0m\n"
    garantir_docker
    if [[ -f .env ]]; then verde "Configuracao existente encontrada (.env) - mantida"; else criar_env; fi
    subir --build
    if esperar_painel; then
      abrir "$(url_painel)"
      printf "\n\033[32m  PRONTO! Abra o painel: %s\033[0m\n" "$(url_painel)"
      echo "  Leia o QR Code com o WhatsApp da barbearia e o atendente comeca a responder."
    fi
    ;;
  iniciar)
    garantir_docker
    [[ -f .env ]] || falha "Ainda nao instalado. Rode ./barbearia.sh instalar"
    subir; esperar_painel && abrir "$(url_painel)"
    ;;
  parar) docker compose stop && verde "Parado." ;;
  logs) docker compose logs -f --tail 100 agente ;;
  atualizar) garantir_docker; docker compose pull postgres evolution; subir --build; esperar_painel ;;
  *) echo "Uso: ./barbearia.sh [instalar|iniciar|parar|logs|atualizar]"; exit 1 ;;
esac
