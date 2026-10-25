import { migrateDatabase } from './migrate.js';
import { closePool } from './pool.js';
import { logger } from '../lib/logger.js';

try {
  await migrateDatabase();
  await closePool();
  process.exit(0);
} catch (error) {
  logger.error({ err: error }, 'Falha ao executar migracoes');
  await closePool().catch(() => undefined);
  process.exit(1);
}
