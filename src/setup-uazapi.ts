import { config } from "./config";

async function main(): Promise<void> {
  if (!config.uazapiUrl || !config.uazapiToken) {
    throw new Error("Preencha UAZAPI_URL e UAZAPI_TOKEN no arquivo .env.");
  }
  if (!config.webhookPublicUrl) {
    throw new Error(
      "Preencha WEBHOOK_PUBLIC_URL com a URL HTTPS pública completa, incluindo /webhook?secret=..."
    );
  }

  const destino = new URL(config.webhookPublicUrl);
  if (destino.protocol !== "https:") {
    throw new Error("WEBHOOK_PUBLIC_URL precisa usar HTTPS público.");
  }
  if (destino.pathname !== "/webhook" || !destino.searchParams.get("secret")) {
    throw new Error("A URL deve terminar em /webhook?secret=SEU_WEBHOOK_SECRET.");
  }

  const response = await fetch(`${config.uazapiUrl}/webhook`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      token: config.uazapiToken,
    },
    body: JSON.stringify({
      enabled: true,
      url: config.webhookPublicUrl,
      events: ["messages"],
      addUrlEvents: false,
      addUrlTypesMessages: false,
    }),
    signal: AbortSignal.timeout(15_000),
  });

  const body = await response.text();
  if (!response.ok) {
    throw new Error(`UAZAPI respondeu HTTP ${response.status}: ${body.slice(0, 500)}`);
  }
  console.log("Webhook da UAZAPI ativado para o evento messages.");
  console.log(`Destino configurado: ${destino.origin}${destino.pathname} (segredo omitido)`);
  if (body.trim()) console.log(`Resposta: ${body.slice(0, 500)}`);
}

main().catch((error: unknown) => {
  console.error("Não foi possível configurar o webhook:", error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
