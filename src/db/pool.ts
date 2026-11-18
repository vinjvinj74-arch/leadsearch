import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../lib/logger.js';
import { getQueryClient } from './clientContext.js';

const { Pool, Client } = pg;

// Mantido para as migrações locais (Node). No Worker, cada operação usa um
// Client novo: o runtime encerra conexões TCP entre invocações e o Pool acabava
// reaproveitando conexões mortas, causando timeouts intermitentes de 10 s.
export const pool = new Pool({
  connectionString: config.databaseUrl || undefined,
  ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
  max: Math.max(Number.parseInt(process.env.PG_POOL_MAX ?? '10', 10) || 10, 1),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (error) => {
  logger.error({ err: error }, 'Erro inesperado no pool PostgreSQL');
});

function createClient(): pg.Client {
  return new Client({
    connectionString: config.databaseUrl || undefined,
    ssl: config.pgSsl ? { rejectUnauthorized: false } : undefined,
    connectionTimeoutMillis: 10000,
  });
}

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  values: unknown[] = [],
): Promise<pg.QueryResult<T>> {
  const client = await getQueryClient();
  return client.query<T>(text, values);
}

export async function withTransaction<T>(fn: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = createClient();
  await client.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}

export async function checkDatabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const started = Date.now();
  try {
    if (!config.databaseUrl) {
      return { ok: false, latencyMs: 0, error: 'DATABASE_URL nao configurada.' };
    }
    await query('SELECT 1');
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Erro desconhecido.';
    logger.error({ err: error, message }, 'Falha ao verificar banco de dados');
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: message,
    };
  }
}

export async function closePool(): Promise<void> {
  await pool.end();
}
