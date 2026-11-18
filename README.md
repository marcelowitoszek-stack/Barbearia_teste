# Agente de IA para Barbearia no WhatsApp

Versão baseada no projeto `gfrabelo/agente-barbearia`, configurada para usar **Gemini** como agente e **UAZAPI** como conexão WhatsApp. Responde dúvidas com base no catálogo, informa preços, coleta preferência de dia/horário e envia o pedido ao barbeiro para confirmação. **Não consulta nem reserva a agenda.**

O projeto não usa nem publica em Railway. Pode ser executado localmente para testes ou em um servidor próprio com Docker Compose. O endpoint do webhook precisa estar acessível publicamente por HTTPS para receber eventos da UAZAPI.

## Requisitos

- Node.js 20 ou superior e npm; alternativamente, Docker Engine com Docker Compose.
- Uma chave da API Gemini, criada no [Google AI Studio](https://aistudio.google.com/apikey).
- Uma instância/conta UAZAPI conectada ao WhatsApp. Consulte [a documentação UAZAPI](https://docs.uazapi.com/).
- Um endereço HTTPS público apontando para este serviço, necessário para o webhook.

## 1. Preparar o agente

```bash
cd agente-barbearia-gemini-uazapi
npm ci
cp .env.example .env
```

Preencha no `.env` ao menos `GEMINI_API_KEY`, `EMPRESA_NOME`, `ATENDENTE_NOME`, `UAZAPI_URL`, `UAZAPI_TOKEN` e `WEBHOOK_SECRET`. Gere um segredo forte com `openssl rand -hex 32`. Defina também `WEBHOOK_PUBLIC_URL` como a URL HTTPS pública completa, por exemplo `https://barbearia.exemplo.com/webhook?secret=SEU_SEGREDO`.

Edite `src/data/catalogo.json` com os serviços, valores, duração e barbeiros corretos. O catálogo fornecido contém preços e nomes ilustrativos; substitua-os antes de atender clientes. Ajuste o tom do agente em `src/prompt.ts`.

Teste o agente sem WhatsApp com `npm run repl` (`/sair` encerra), compile com `npm run build` e valide chave, modelo e chamadas de ferramenta com `npm run check`.

## 2. Executar o serviço

### Local

```bash
npm run build
npm start
```

O serviço escuta em `PORT` (padrão `3000`). Verifique `http://localhost:3000/health`. Para desenvolvimento, use `npm run dev`.

### Docker Compose

Com o `.env` preenchido:

```bash
docker compose up -d --build
docker compose logs -f
docker compose down
```

O Compose publica a porta configurada no host. Em um servidor, configure seu proxy reverso/domínio para encaminhar HTTPS até essa porta, sem expor o serviço sem proteção. Para um teste local com UAZAPI, use um túnel HTTPS de sua escolha. Não há publicação automática: você controla a máquina, o domínio e o processo.

## 3. Conectar à UAZAPI

1. No painel UAZAPI, crie uma instância e conecte o WhatsApp escaneando o QR Code. Use preferencialmente uma conta WhatsApp Business dedicada ao atendimento.
2. Copie a Server URL para `UAZAPI_URL` e o Instance Token para `UAZAPI_TOKEN` no `.env`.
3. Garanta que o servidor esteja rodando e que `WEBHOOK_PUBLIC_URL` aponte para ele com HTTPS e com o mesmo segredo de `WEBHOOK_SECRET`.
4. Registre/ative o webhook pelo comando:

   ```bash
   npm run setup:uazapi
   ```

   O comando configura o evento `messages` na instância usando a autenticação por token da UAZAPI. Alternativamente, cadastre no painel a URL `WEBHOOK_PUBLIC_URL` e o evento `messages`.
5. Envie uma mensagem para o número da instância a partir de outro telefone e acompanhe `docker compose logs -f` ou o terminal do processo.

Se quiser que o pedido chegue diretamente ao WhatsApp do barbeiro, configure `HUMANO_WHATSAPP` com o telefone completo (55 + DDD + número). O pedido também aparece nos logs do serviço. Opcionalmente, `LEAD_WEBHOOK_URL` envia o registro em JSON a um CRM ou automação.

## O que acontece no atendimento

O agente usa Gemini com chamadas de ferramentas para consultar serviços e registrar o pedido. A lista de preços vem do arquivo de catálogo e não deve ser inventada. O atendente coleta serviço, nome, dia/horário preferido, barbeiro e se a pessoa já é cliente. O barbeiro recebe os dados e confirma a disponibilidade na agenda. Quando a equipe responde manualmente à conversa, o bot pausa para não falar por cima.

O estado de conversa e leads fica em memória e nos logs; reiniciar o processo apaga conversas em andamento. Para operação crítica, configure `HUMANO_WHATSAPP` ou `LEAD_WEBHOOK_URL` e adote armazenamento durável. Tokens e chaves ficam somente no `.env`: não publique esse arquivo nem o envie ao Git.

## Principais variáveis

- `GEMINI_API_KEY`, `GEMINI_MODEL`: credencial e modelo Gemini.
- `UAZAPI_URL`, `UAZAPI_TOKEN`: URL base e token da instância.
- `WEBHOOK_SECRET`, `WEBHOOK_PUBLIC_URL`: autenticação do receptor e URL pública que a UAZAPI chama.
- `EMPRESA_NOME`, `EMPRESA_CIDADE`, `ATENDENTE_NOME`, `TIMEZONE`: identidade e fuso local.
- `HUMANO_WHATSAPP`: número que recebe o pedido pronto.
- `PORT`: porta HTTP do serviço; padrão `3000`.

Confira todas as opções comentadas em `.env.example`. Não coloque chaves reais no repositório.

## Licença

[MIT](LICENSE).
