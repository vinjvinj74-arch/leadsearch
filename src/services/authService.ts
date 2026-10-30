import { createHmac, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import type { AuthUser } from '../types/session.js';
import { clearCsrfCookie, clearSessionCookie, setCsrfCookie, setSessionCookie } from '../lib/cookies.js';
import { hashIp, requestIp } from '../lib/http.js';
import { unauthorized } from '../lib/errors.js';
import { normalizeRole, type UserRole } from '../plans.js';
import {
  entitlementsFromRow,
  loadSubscription,
  type SubscriptionRow,
} from './subscriptionService.js';

export interface UserRow {
  id: string;
  name: string;
  email: string;
  password_hash: string;
  email_verified_at: Date | null;
  failed_login_attempts: number;
  locked_until: Date | null;
  created_at: Date;
  role?: UserRole | 'admin' | null;
}

export interface UserSubscriptionRow {
  plan_id: string | null;
  credits_limit: number;
  credits_used: number;
  credits_reset_at: Date | null;
  status: string;
  current_period_end?: Date | null;
  cancel_at_period_end?: boolean;
  provider?: string | null;
}

export function toAuthUser(
  row: UserRow,
  subscription?: SubscriptionRow | UserSubscriptionRow | null,
): AuthUser {
  const role = normalizeRole(row.role ?? 'user');
  const entitlements = entitlementsFromRow(
    row.id,
    role,
    subscription as SubscriptionRow | null | undefined,
  );
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    emailVerifiedAt: row.email_verified_at ? row.email_verified_at.toISOString() : null,
    createdAt: row.created_at.toISOString(),
    role: entitlements.role,
    isSuperAdmin: entitlements.isSuperAdmin,
    planId: entitlements.planId,
    planName: entitlements.planName,
    planStatus: entitlements.status,
    creditsLimit: entitlements.creditsLimit,
    creditsUsed: entitlements.creditsUsed,
    creditsRemaining: entitlements.creditsRemaining,
    canSearch: entitlements.canSearch,
    active: entitlements.active,
    unlimited: entitlements.unlimited,
    accessReason: entitlements.reason,
    renewsAt: entitlements.renewsAt,
    provider: entitlements.provider,
    providerCustomerId: entitlements.providerCustomerId,
    creditUnit: entitlements.creditUnit,
    needsUpgrade: !entitlements.canSearch,
  };
}

export async function getUserSubscription(userId: string): Promise<UserSubscriptionRow | null> {
  const row = await loadSubscription(userId);
  return row;
}

export function hashToken(token: string): string {
  return createHmac('sha256', config.sessionSecret).update(token).digest('hex');
}

export function newToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function newCsrfToken(): string {
  return randomBytes(32).toString('base64url');
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
  });
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

export function ipHashForRequest(req: Request): string {
  return hashIp(requestIp(req));
}

export async function createSession(req: Request, res: Response, userId: string): Promise<void> {
  const token = newToken(32);
  const csrfToken = newCsrfToken();
  const expiresAt = new Date(Date.now() + config.sessionTtlDays * 24 * 60 * 60 * 1000);
  const userAgent = String(req.headers['user-agent'] ?? '').slice(0, 300);
  await query(
    `INSERT INTO sessions (user_id, token_hash, user_agent, ip_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hashToken(token), userAgent, ipHashForRequest(req), expiresAt],
  );
  setSessionCookie(res, token);
  setCsrfCookie(res, csrfToken);
}

export async function revokeCurrentSession(req: Request, res: Response): Promise<void> {
  if (req.authSession) {
    await query('UPDATE sessions SET revoked_at = now() WHERE id = $1', [req.authSession.id]);
  }
  clearSessionCookie(res);
  clearCsrfCookie(res);
}

export async function revokeUserSessions(userId: string, exceptSessionId?: string): Promise<void> {
  if (exceptSessionId) {
    await query(
      'UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL',
      [userId, exceptSessionId],
    );
  } else {
    await query('UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  }
}

export async function findUserByEmail(email: string): Promise<UserRow | null> {
  const result = await query<UserRow>('SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
  return result.rows[0] ?? null;
}

export async function findUserById(id: string): Promise<UserRow | null> {
  const result = await query<UserRow>('SELECT * FROM users WHERE id = $1 LIMIT 1', [id]);
  return result.rows[0] ?? null;
}

/**
 * Garante apenas a existencia do registro de assinatura.
 * A renovacao de creditos e feita exclusivamente por webhooks oficiais ou
 * pela rotina de assinaturas manuais, nunca pela leitura do perfil.
 */
export async function ensureUserSubscription(userId: string): Promise<UserSubscriptionRow | null> {
  const existing = await getUserSubscription(userId);
  if (existing) return existing;

  try {
    const created = await query<UserSubscriptionRow>(
      `INSERT INTO user_subscriptions (user_id, plan_id, status, credits_limit, credits_used, credits_reset_at)
       VALUES ($1, NULL, 'pending', 0, 0, NULL)
       ON CONFLICT (user_id) DO UPDATE SET updated_at = now()
       RETURNING plan_id, credits_limit, credits_used, credits_reset_at, status`,
      [userId],
    );
    return created.rows[0] ?? null;
  } catch {
    return null;
  }
}

export async function requireUserRecord(userId: string): Promise<UserRow> {
  const user = await findUserById(userId);
  if (!user) throw unauthorized('Sessao invalida.');
  return user;
}
