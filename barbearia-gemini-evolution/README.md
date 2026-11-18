# Atendente de IA para Barbearia no WhatsApp

Um atendente virtual que responde os clientes da barbearia no WhatsApp **24 horas por dia**:

- tira dúvidas sobre os serviços;
- passa os preços (só os que estão cadastrados, nunca inventa);
- combina dia, horário e barbeiro de preferência;
- entende **áudio** do cliente;
- envia o **pedido pronto** para o WhatsApp do barbeiro confirmar.

A inteligência é o **Gemini** (Google). A conexão com o WhatsApp usa a **Evolution API**, que é gratuita e roda no seu próprio computador. Não usa Railway nem servidor na nuvem, e não precisa de domínio nem HTTPS.

> O atendente **não** confirma horário na agenda. Ele anota o que o cliente quer e o barbeiro confirma.

---

## Instalação

O único programa necessário é o **Docker Desktop** (gratuito). O instalador verifica e ajuda a instalar.

### Windows 10/11

1. Copie a pasta `barbearia-gemini-evolution` para o computador (pendrive, Google Drive, zip...).
2. Dê dois cliques em **`INSTALAR.bat`**.
3. Se o Docker não estiver instalado, o instalador oferece instalar. Depois **reinicie o computador**, abra o Docker Desktop uma vez, aceite os termos e rode o `INSTALAR.bat` de novo.
4. Responda as perguntas: chave do Gemini, nome da barbearia, nome do atendente e WhatsApp do barbeiro.
5. O painel abre sozinho no navegador. **Leia o QR Code** com o WhatsApp da barbearia e pronto.

Também é criado o atalho **"Painel da Barbearia"** na área de trabalho.

### macOS / Linux

```bash
chmod +x barbearia.sh
```

```bash
./barbearia.sh instalar
```

No Mac, instale antes o [Docker Desktop](https://www.docker.com/products/docker-desktop/). No Linux, o script instala o Docker sozinho se ele não existir.

### Chave do Gemini (grátis)

1. Acesse [aistudio.google.com/apikey](https://aistudio.google.com/apikey) com uma conta Google.
2. Clique em **Create API key** e copie a chave.
3. Cole no instalador ou depois em **Painel → Configurações**.

---

## Uso diário

| Windows | Mac/Linux | O que faz |
|---|---|---|
| `INICIAR.bat` | `./barbearia.sh iniciar` | Liga o atendente e abre o painel |
| `PARAR.bat` | `./barbearia.sh parar` | Desliga o atendente |
| `VER-LOGS.bat` | `./barbearia.sh logs` | Mostra as conversas em tempo real |
| `ATUALIZAR.bat` | `./barbearia.sh atualizar` | Baixa versões novas e religa |

O sistema **liga sozinho** quando o Docker Desktop liga. Para funcionar 24h, deixe o computador ligado, com internet e sem entrar em suspensão. No Docker Desktop, mantenha marcada a opção *Settings → General → Start Docker Desktop when you sign in*.

### Painel: http://localhost:3737

- **WhatsApp**: status, QR Code para conectar (ou código de pareamento) e botão para desconectar.
- **Pedidos**: todos os pedidos que o atendente fechou, com link para o WhatsApp do cliente.
- **Serviços e preços**: edite serviços, valores, duração e barbeiros. Vale na hora.
- **Configurações**: nome da barbearia, atendente, endereço, horário, WhatsApp do barbeiro, chave do Gemini e um botão para ligar/desligar o atendimento.
- **Testar atendente**: converse com o atendente como se fosse um cliente, sem usar o WhatsApp.

O painel só abre no próprio computador onde está instalado (por segurança, ele não fica acessível pela rede).

### Como o atendente sai da frente

- Quando **alguém da equipe responde pelo celular**, o atendente para de responder aquele cliente por 60 minutos.
- Depois que o **pedido é enviado ao barbeiro**, o atendente fica em silêncio naquela conversa por 2 horas.
- Grupos, status e canais são ignorados.

---

## Google Agenda (opcional)

Com a agenda conectada, o atendente **consulta os horários livres**, oferece só o que está vago e **cria o evento** na sua Google Agenda. O título do evento leva o serviço, o nome do cliente e o barbeiro; a duração vem do cadastro de serviços; a descrição leva o WhatsApp do cliente.

1. No [Google Cloud Console](https://console.cloud.google.com), crie um projeto, ative a **Google Calendar API** e crie uma **conta de serviço**. Baixe a chave em **JSON**.
2. Coloque o arquivo `.json` na pasta `dados/`.
3. Na Google Agenda: ⚙ Configurações → sua agenda → **Compartilhar com pessoas específicas** → adicione o e-mail da conta de serviço com a permissão **Fazer alterações nos eventos**.
4. No painel, em **Configurações → Google Agenda**, cole o **ID da agenda** (em "Integrar agenda"; normalmente é o seu e-mail), ajuste o **Expediente** e clique em **Testar agenda**.

Como os horários livres são calculados:

- Só dentro do expediente e dos dias abertos, fora da pausa e respeitando a antecedência mínima.
- Eventos marcados como **Ocupado** bloqueiam o horário. Eventos **Disponível** (como aniversários) não bloqueiam. Para folga ou feriado, crie um evento de dia inteiro e marque como Ocupado.
- **Clientes ao mesmo tempo** define quantos atendimentos podem se sobrepor (uma por cadeira).
- Antes de gravar, o horário é conferido de novo. Se alguém ocupou no meio da conversa, o atendente oferece outro.

Se a agenda falhar, o pedido **não se perde**: vai para o WhatsApp do barbeiro e para a aba Pedidos com o aviso "não entrou na agenda". O simulador "Testar atendente" consulta a agenda real, mas **nunca grava** nela.

A chave `.json` fica só na pasta `dados/`: ela não entra na imagem Docker nem no Git. Não compartilhe esse arquivo.

---

## Instalar em vários computadores

Cada computador é uma instalação independente, com o seu próprio WhatsApp conectado. Para levar para outra máquina, copie a pasta **sem** o arquivo `.env` e rode o instalador; ele gera senhas novas.

Para **mudar** uma barbearia de computador mantendo serviços e pedidos, copie também a pasta `dados/` (catálogo, configurações e pedidos). Será preciso ler o QR Code de novo.

Um mesmo número de WhatsApp só deve estar conectado em **uma** instalação por vez.

---

## O que fica onde

```
INSTALAR.bat / barbearia.sh   instaladores
docker-compose.yml            banco + Evolution API + atendente
.env                          senhas e dados iniciais (criado pelo instalador; não compartilhe)
dados/catalogo.json           serviços e preços (editável pelo painel)
dados/configuracoes.json      o que foi salvo pelo painel
dados/pedidos.jsonl           histórico de pedidos (uma linha por pedido)
dados/<chave>.json            chave da conta de serviço do Google (não compartilhe)
src/agenda.ts                 integração com a Google Agenda
src/prompt.ts                 personalidade e regras do atendente
src/tools.ts                  busca de serviços e registro do pedido
src/evolution.ts              integração com a Evolution API
public/index.html             painel
```

### Opcional: enviar pedidos para planilha/CRM

Preencha `LEAD_WEBHOOK_URL` no `.env` com uma URL do n8n, Make, Zapier etc. Cada pedido é enviado como JSON. Depois rode `INICIAR.bat`.

### Para desenvolvedores

```bash
npm ci
```

```bash
npm run repl
```

```bash
npm run check
```

`repl` conversa com o atendente no terminal e `check` valida a chave, o modelo e as chamadas de ferramenta do Gemini. Os dois leem o `.env` da pasta.

---

## Problemas comuns

- **"Falta a chave" no painel**: cole a chave do Gemini em Configurações.
- **QR Code não aparece**: na primeira vez a Evolution leva 1 a 2 minutos para ligar. Aguarde; a página atualiza sozinha.
- **O atendente não responde**: veja `VER-LOGS.bat`. Confira se o atendimento está ligado em Configurações e se a conversa não foi pausada porque alguém respondeu pelo celular.
- **Erro de modelo (404)**: o Google aposenta modelos de tempos em tempos. Troque o modelo em Configurações (ex.: um modelo `flash` atual) ou rode `npm run check` para ver os disponíveis.
- **Porta em uso**: o instalador escolhe outra automaticamente. O endereço certo do painel aparece no final da instalação e no atalho da área de trabalho.

## Aviso

A Evolution API conecta pelo WhatsApp Web (não é a API oficial da Meta). Use um número dedicado à barbearia, responda só quem chamou e não envie mensagens em massa, para evitar bloqueios.

## Licença

[MIT](LICENSE).
