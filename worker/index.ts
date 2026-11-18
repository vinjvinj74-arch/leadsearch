import { DurableObject, type DurableObjectState } from "cloudflare:workers";

const PORT = 8080;
const INACTIVITY_TIMEOUT_MS = 30 * 60 * 1000;
const CONTAINER_NAME = "radar-api";

interface Env {
  RADAR_CONTAINER: DurableObjectNamespace<RadarContainer>;
  DATABASE_URL: string;
  SESSION_SECRET: string;
  APP_ORIGINS?: string;
  APP_URL?: string;
  SESSION_TTL_DAYS?: string;
  SESSION_IDLE_DAYS?: string;
  APIFY_API_TOKEN?: string;
  GOOGLE_MAPS_API_KEY?: string;
  SMTP_HOST?: string;
  SMTP_PORT?: string;
  SMTP_SECURE?: string;
  SMTP_USER?: string;
  SMTP_PASS?: string;
  SMTP_FROM?: string;
  MAX_SEARCH_RESULTS?: string;
  EXPORT_MAX_ROWS?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_PRICE_STARTER?: string;
  STRIPE_PRICE_PRO?: string;
  STRIPE_PRICE_BUSINESS?: string;
}

/** Variáveis repassadas ao processo Express dentro do container. */
function containerEnvironment(env: Env): Record<string, string> {
  const values: Record<string, string | undefined> = {
    NODE_ENV: "production",
    PORT: String(PORT),
    PGSSL: "true",
    COOKIE_SECURE: "true",
    DATABASE_URL: env.DATABASE_URL,
    SESSION_SECRET: env.SESSION_SECRET,
    APP_ORIGINS: env.APP_ORIGINS,
    APP_URL: env.APP_URL,
    SESSION_TTL_DAYS: env.SESSION_TTL_DAYS,
    SESSION_IDLE_DAYS: env.SESSION_IDLE_DAYS,
    APIFY_API_TOKEN: env.APIFY_API_TOKEN,
    GOOGLE_MAPS_API_KEY: env.GOOGLE_MAPS_API_KEY,
    SMTP_HOST: env.SMTP_HOST,
    SMTP_PORT: env.SMTP_PORT,
    SMTP_SECURE: env.SMTP_SECURE,
    SMTP_USER: env.SMTP_USER,
    SMTP_PASS: env.SMTP_PASS,
    SMTP_FROM: env.SMTP_FROM,
    MAX_SEARCH_RESULTS: env.MAX_SEARCH_RESULTS,
    EXPORT_MAX_ROWS: env.EXPORT_MAX_ROWS,
    STRIPE_SECRET_KEY: env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: env.STRIPE_WEBHOOK_SECRET,
    STRIPE_PRICE_STARTER: env.STRIPE_PRICE_STARTER,
    STRIPE_PRICE_PRO: env.STRIPE_PRICE_PRO,
    STRIPE_PRICE_BUSINESS: env.STRIPE_PRICE_BUSINESS,
  };

  return Object.fromEntries(
    Object.entries(values).flatMap(([key, value]) => (value === undefined ? [] : [[key, value]])),
  );
}

export class RadarContainer extends DurableObject<Env> {
  private starting: Promise<void> | undefined;
  private monitoring: Promise<void> | undefined;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const container = ctx.container;
    if (container?.running) {
      void ctx.blockConcurrencyWhile(() =>
        container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS),
      );
      this.observeExit();
    }
  }

  async fetch(request: Request): Promise<Response> {
    this.starting ??= this.startAndWait().finally(() => {
      this.starting = undefined;
    });
    await this.starting;

    const url = new URL(request.url);
    url.protocol = "http:";
    url.host = "container";
    const forwarded = new Request(url, request);
    forwarded.headers.delete("host");
    return this.ctx.container!.getTcpPort(PORT).fetch(forwarded);
  }

  private async startAndWait(): Promise<void> {
    const container = this.ctx.container!;
    if (!container.running) {
      container.start({
        image: container.images.base,
        instance: "lite",
        enableInternet: true,
        env: containerEnvironment(this.env),
      });
    }
    this.observeExit();
    await container.setInactivityTimeout(INACTIVITY_TIMEOUT_MS);

    const port = container.getTcpPort(PORT);
    for (let attempt = 0; attempt < 300; attempt += 1) {
      try {
        const response = await port.fetch("http://container/api/health", {
          signal: AbortSignal.timeout(2000),
        });
        await response.body?.cancel();
        if (response.ok) return;
      } catch {
        // O servidor ainda está iniciando.
      }
      await scheduler.wait(500);
    }
    throw new Error("Container RADAR não ficou pronto na porta 8080");
  }

  private observeExit(): void {
    if (this.monitoring) return;
    this.monitoring = this.ctx
      .container!.monitor()
      .catch(() => undefined)
      .finally(() => {
        this.monitoring = undefined;
      });
    this.ctx.waitUntil(this.monitoring);
  }
}

export default {
  fetch(request: Request, env: Env): Promise<Response> {
    // Instância única: o backend mantém estado em memória (fila do Apify,
    // cache de geocodificação e limitadores) que não pode ser dividido.
    return env.RADAR_CONTAINER.getByName(CONTAINER_NAME).fetch(request);
  },
} satisfies ExportedHandler<Env>;
