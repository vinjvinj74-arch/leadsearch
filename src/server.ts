import http from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { migrateDatabase } from './db/migrate.js';
import { closePool } from './db/pool.js';
import { logger } from './lib/logger.js';
import { recoverStaleRadarSearches } from './services/radarService.js';
import { recoverStaleSearches } from './services/searchService.js';
import { renewManualSubscriptions } from './services/subscriptionService.js';

async function start(): Promise<void> {
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      await migrateDatabase();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      logger.warn({ attempt, err: error }, 'Banco indisponivel para migracao; aguardando');
      await new Promise((resolve) => setTimeout(resolve, 3000));
    }
  }
  if (lastError) throw lastError;

  await recoverStaleSearches().catch((error) => {
    logger.warn({ err: error }, 'Falha ao recuperar pesquisas antigas');
  });
  await recoverStaleRadarSearches().catch((error) => {
    logger.warn({ err: error }, 'Falha ao recuperar pesquisas do Radar antigas');
  });

  const renew = () => {
    renewManualSubscriptions()
      .then((count) => {
        if (count) logger.info({ count }, 'Assinaturas manuais renovadas');
      })
      .catch((error) => logger.warn({ err: error }, 'Falha ao renovar assinaturas manuais'));
  };
  renew();
  setInterval(renew, 60 * 60 * 1000).unref();

  const app = createApp();
  const server = http.createServer(app);
  server.requestTimeout = 30000;
  server.headersTimeout = 35000;

  server.listen(config.port, () => {
    logger.info({ port: config.port, env: config.env }, 'RADAR iniciado');
  });

  const shutdown = (signal: string) => {
    logger.info({ signal }, 'Encerrando RADAR');
    server.close(() => {
      closePool()
        .catch(() => undefined)
        .finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (reason) => {
    logger.error({ err: reason }, 'Promise rejeitada sem tratamento');
  });
  process.on('uncaughtException', (error) => {
    logger.fatal({ err: error }, 'Excecao nao tratada');
    process.exit(1);
  });
}

start().catch((error) => {
  logger.fatal({ err: error }, 'Falha ao iniciar RADAR');
  process.exit(1);
});
