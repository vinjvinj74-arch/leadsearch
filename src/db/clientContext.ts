import { AsyncLocalStorage } from 'node:async_hooks';
import pg from 'pg';
import { config } from '../config.js';

interface RequestDbState {
  client: pg.Client | null;
  connecting: Promise<pg.Client> | null;
}

// Uma conexão por requisição: evita o custo de um handshake por query e, ao
// mesmo tempo, não reaproveita conexões entre invocações do Worker (o runtime
// encerra conexões TCP quando o isolate é congelado).
const storage = new AsyncLocalStorage<RequestDbState>();

export function runWithDbContext<T>(fn: () => T): T {
  return storage.run({ client: null, connecting: null }, fn);
}

function createClient(): pg.Client {
  return new pg.Client({
    connectionString: config.databaseUrl || undefined,
    ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10000,
  });
}

export async function getQueryClient(): Promise<pg.Client> {
  const state = storage.getStore();
  if (!state) return createClient();
  if (state.client) return state.client;
  if (state.connecting) return state.connecting;

  state.connecting = (async () => {
    const client = createClient();
    await client.connect();
    state.client = client;
    return client;
  })();
  return state.connecting;
}

export async function closeRequestClient(): Promise<void> {
  const state = storage.getStore();
  if (!state?.client) return;
  await state.client.end().catch(() => undefined);
  state.client = null;
  state.connecting = null;
}
