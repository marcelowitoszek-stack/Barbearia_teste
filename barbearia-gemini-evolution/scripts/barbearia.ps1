# Instalador e controle do Atendente de IA da Barbearia (Windows).
# Usado pelos arquivos INSTALAR.bat, INICIAR.bat, PARAR.bat e VER-LOGS.bat.

param([ValidateSet("instalar", "iniciar", "parar", "logs", "atualizar")] [string]$Acao = "instalar")

# "Continue": no PowerShell 5, stderr de programa externo com "Stop" vira erro fatal.
$ErrorActionPreference = "Continue"
try { [Console]::OutputEncoding = [Text.Encoding]::UTF8 } catch {}
$Raiz = Split-Path -Parent $PSScriptRoot
Set-Location $Raiz
$EnvArq = Join-Path $Raiz ".env"

function Titulo($t) { Write-Host ""; Write-Host "== $t ==" -ForegroundColor Cyan }
function Ok($t) { Write-Host "  [ok] $t" -ForegroundColor Green }
function Aviso($t) { Write-Host "  [!] $t" -ForegroundColor Yellow }
function Falha($t) {
  Write-Host ""; Write-Host "  [X] $t" -ForegroundColor Red; Write-Host ""
  Read-Host "Pressione Enter para fechar" | Out-Null
  exit 1
}

function Ler-Env {
  $m = @{}
  if (Test-Path $EnvArq) {
    foreach ($l in [IO.File]::ReadAllLines($EnvArq)) {
      if ($l -match '^\s*([A-Z_]+)\s*=(.*)$') { $m[$Matches[1]] = $Matches[2].Trim() }
    }
  }
  return $m
}

function Segredo([int]$bytes = 24) {
  $b = New-Object byte[] $bytes
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($b)
  return (($b | ForEach-Object { $_.ToString("x2") }) -join "")
}

function Porta-Livre([int]$p) {
  try {
    $l = New-Object Net.Sockets.TcpListener([Net.IPAddress]::Loopback, $p)
    $l.Start(); $l.Stop(); return $true
  } catch { return $false }
}

function Escolher-Porta([int]$preferida) {
  $p = $preferida
  while (-not (Porta-Livre $p)) { $p++ }
  return $p
}

# --------------------------------------------------------------------------
# Docker
# --------------------------------------------------------------------------

function Garantir-Docker {
  Titulo "Verificando o Docker"
  if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
    Aviso "O Docker Desktop nao esta instalado. Ele e gratuito e e o unico programa necessario."
    $r = Read-Host "  Instalar agora automaticamente? (S/n)"
    if ($r -eq "" -or $r -match '^[sS]') {
      if (Get-Command winget -ErrorAction SilentlyContinue) {
        winget install -e --id Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
        Write-Host ""
        Aviso "Docker instalado. REINICIE o computador, abra o Docker Desktop uma vez (aceite os termos)"
        Aviso "e depois rode o INSTALAR.bat de novo."
        Read-Host "Pressione Enter para fechar" | Out-Null
        exit 0
      }
    }
    Start-Process "https://www.docker.com/products/docker-desktop/"
    Falha "Instale o Docker Desktop pelo site que abriu, reinicie o computador e rode o INSTALAR.bat de novo."
  }

  docker info *> $null
  if ($LASTEXITCODE -ne 0) {
    Aviso "O Docker esta instalado mas desligado. Abrindo o Docker Desktop..."
    $exe = Join-Path $env:ProgramFiles "Docker\Docker\Docker Desktop.exe"
    if (Test-Path $exe) { Start-Process $exe }
    $limite = (Get-Date).AddMinutes(4)
    do {
      Start-Sleep -Seconds 5
      Write-Host "  aguardando o Docker ligar..." -ForegroundColor DarkGray
      docker info *> $null
    } while ($LASTEXITCODE -ne 0 -and (Get-Date) -lt $limite)
    if ($LASTEXITCODE -ne 0) {
      Falha "O Docker nao ligou. Abra o Docker Desktop manualmente, espere ficar verde e rode de novo."
    }
  }
  docker compose version *> $null
  if ($LASTEXITCODE -ne 0) { Falha "Seu Docker e antigo (sem 'docker compose'). Atualize o Docker Desktop." }
  Ok "Docker funcionando"
}

# --------------------------------------------------------------------------
# .env
# --------------------------------------------------------------------------

function Criar-Env {
  Titulo "Configuracao inicial"
  Write-Host "  Responda algumas perguntas. Tudo pode ser alterado depois no painel."
  Write-Host ""
  Write-Host "  Chave do Gemini: crie gratis em https://aistudio.google.com/apikey" -ForegroundColor DarkGray
  Write-Host "  (pode deixar em branco e colar depois no painel)" -ForegroundColor DarkGray
  $gemini = Read-Host "  Chave do Gemini"
  $nome = Read-Host "  Nome da barbearia (ex: Barbearia do Ze)"
  if (-not $nome) { $nome = "Minha Barbearia" }
  $cidade = Read-Host "  Cidade (opcional)"
  $atendente = Read-Host "  Nome do atendente virtual (Enter = Alex)"
  if (-not $atendente) { $atendente = "Alex" }
  $barbeiro = Read-Host "  WhatsApp do barbeiro que recebe os pedidos, com 55 e DDD (opcional)"
  $barbeiro = ($barbeiro -replace '\D', '')

  $painel = Escolher-Porta 3737
  $evo = Escolher-Porta 8787

  $modelo = Get-Content (Join-Path $Raiz ".env.example") -Encoding UTF8
  $valores = @{
    GEMINI_API_KEY    = $gemini.Trim()
    EMPRESA_NOME      = $nome.Trim()
    EMPRESA_CIDADE    = $cidade.Trim()
    ATENDENTE_NOME    = $atendente.Trim()
    HUMANO_WHATSAPP   = $barbeiro
    EVOLUTION_API_KEY = Segredo
    WEBHOOK_SECRET    = Segredo
    POSTGRES_SENHA    = Segredo 16
    PAINEL_PORTA      = "$painel"
    EVOLUTION_PORTA   = "$evo"
  }
  $saida = foreach ($l in $modelo) {
    if ($l -match '^([A-Z_]+)=' -and $valores.ContainsKey($Matches[1])) { "$($Matches[1])=$($valores[$Matches[1]])" }
    else { $l }
  }
  # UTF-8 SEM BOM: o docker compose nao entende o BOM do PowerShell 5.
  [IO.File]::WriteAllLines($EnvArq, $saida, (New-Object Text.UTF8Encoding($false)))
  Ok "Arquivo .env criado (guarde-o: ele tem as senhas deste computador)"
}

# --------------------------------------------------------------------------
# Acoes
# --------------------------------------------------------------------------

function Url-Painel { $e = Ler-Env; $p = $e["PAINEL_PORTA"]; if (-not $p) { $p = "3737" }; return "http://localhost:$p" }

function Esperar-Painel {
  $url = Url-Painel
  Titulo "Aguardando o sistema ligar"
  $limite = (Get-Date).AddMinutes(5)
  while ((Get-Date) -lt $limite) {
    try {
      $r = Invoke-WebRequest "$url/health" -UseBasicParsing -TimeoutSec 3
      if ($r.StatusCode -eq 200) { Ok "Sistema no ar"; return $true }
    } catch {}
    Start-Sleep -Seconds 3
    Write-Host "  ..." -ForegroundColor DarkGray
  }
  Aviso "Demorou mais que o esperado. Veja os detalhes com VER-LOGS.bat"
  return $false
}

function Criar-Atalho {
  try {
    $desk = [Environment]::GetFolderPath("Desktop")
    $arq = Join-Path $desk "Painel da Barbearia.url"
    [IO.File]::WriteAllLines($arq, @("[InternetShortcut]", "URL=$(Url-Painel)"))
    Ok "Atalho 'Painel da Barbearia' criado na area de trabalho"
  } catch { }
}

function Subir([switch]$Build) {
  Titulo "Ligando banco, WhatsApp (Evolution) e atendente"
  if ($Build) { docker compose up -d --build } else { docker compose up -d }
  if ($LASTEXITCODE -ne 0) { Falha "Nao consegui ligar os servicos. Veja a mensagem acima." }
}

switch ($Acao) {
  "instalar" {
    Write-Host ""
    Write-Host "  ATENDENTE DE IA DA BARBEARIA - instalacao" -ForegroundColor Cyan
    Garantir-Docker
    if (Test-Path $EnvArq) { Ok "Configuracao existente encontrada (.env) - mantida" } else { Criar-Env }
    Subir -Build
    if (Esperar-Painel) {
      Criar-Atalho
      Start-Process (Url-Painel)
      Write-Host ""
      Write-Host "  PRONTO! O painel abriu no navegador: $(Url-Painel)" -ForegroundColor Green
      Write-Host "  Leia o QR Code com o WhatsApp da barbearia e o atendente comeca a responder."
      Write-Host "  O sistema liga sozinho junto com o Docker Desktop. Deixe o computador ligado."
    }
    Write-Host ""
    Read-Host "Pressione Enter para fechar" | Out-Null
  }
  "iniciar" {
    Garantir-Docker
    if (-not (Test-Path $EnvArq)) { Falha "Ainda nao instalado. Rode o INSTALAR.bat primeiro." }
    Subir
    if (Esperar-Painel) { Start-Process (Url-Painel) }
    Start-Sleep -Seconds 3
  }
  "parar" {
    Titulo "Parando o atendente"
    docker compose stop
    Ok "Parado. Para ligar de novo use o INICIAR.bat"
    Start-Sleep -Seconds 3
  }
  "atualizar" {
    Garantir-Docker
    Titulo "Atualizando"
    docker compose pull postgres evolution
    Subir -Build
    Esperar-Painel | Out-Null
    Read-Host "Pressione Enter para fechar" | Out-Null
  }
  "logs" {
    Write-Host "Mostrando o que o atendente esta fazendo (feche a janela para sair)..." -ForegroundColor Cyan
    docker compose logs -f --tail 100 agente
  }
}
