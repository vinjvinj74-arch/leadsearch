import type { Request } from 'express';
import { query } from '../db/pool.js';
import { logger } from './logger.js';

export function recordAudit(
  req: Request,
  action: string,
  entity: string | null = null,
  entityId: string | null = null,
  metadata: Record<string, unknown> = {},
): void {
  const userId = req.user?.id ?? null;
  query(
    `INSERT INTO audit_logs (user_id, action, entity, entity_id, ip_hash, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [userId, action, entity, entityId, req.clientIpHash ?? null, JSON.stringify(metadata)],
  ).catch((error) => {
    logger.warn({ err: error, action }, 'Falha ao registrar auditoria');
  });
}
