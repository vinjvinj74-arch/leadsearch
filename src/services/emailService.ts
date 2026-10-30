import nodemailer, { type Transporter } from 'nodemailer';
import { config } from '../config.js';
import { query } from '../db/pool.js';
import { AppError, integrationNotConfigured, badRequest } from '../lib/errors.js';
import { logger } from '../lib/logger.js';
import { hashToken, newToken } from './authService.js';

let transporter: Transporter | null = null;

export function isEmailConfigured(): boolean {
  return Boolean(config.smtp.host && config.smtp.from);
}

function getTransporter(): Transporter {
  if (!isEmailConfigured()) {
    throw integrationNotConfigured(
      'Servico de e-mail nao configurado. Defina SMTP_HOST e SMTP_FROM para habilitar recuperacao de senha e verificacao.',
    );
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
    });
  }
  return transporter;
}

export function publicBaseUrl(): string {
  if (config.appUrl) return config.appUrl;
  const railwayDomain = process.env.RAILWAY_PUBLIC_DOMAIN;
  if (railwayDomain) return `https://${railwayDomain}`;
  return `http://localhost:${config.port}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

async function send(to: string, subject: string, text: string, html: string): Promise<void> {
  await getTransporter().sendMail({ from: config.smtp.from, to, subject, text, html });
}

export async function createEmailToken(
  userId: string,
  type: 'verify_email' | 'reset_password',
  ttlMinutes: number,
): Promise<string> {
  await query('DELETE FROM email_tokens WHERE user_id = $1 AND type = $2 AND used_at IS NULL', [userId, type]);
  const token = newToken(32);
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
  await query(
    'INSERT INTO email_tokens (user_id, type, token_hash, expires_at) VALUES ($1, $2, $3, $4)',
    [userId, type, hashToken(token), expiresAt],
  );
  return token;
}

export async function consumeEmailToken(
  token: string,
  type: 'verify_email' | 'reset_password',
): Promise<string> {
  const result = await query<{ user_id: string }>(
    `UPDATE email_tokens
     SET used_at = now()
     WHERE token_hash = $1 AND type = $2 AND used_at IS NULL AND expires_at > now()
     RETURNING user_id`,
    [hashToken(token), type],
  );
  const userId = result.rows[0]?.user_id;
  if (!userId) {
    throw badRequest('Token invalido ou expirado.');
  }
  return userId;
}

export async function sendVerificationEmail(email: string, name: string, token: string): Promise<void> {
  const link = `${publicBaseUrl()}/#/verify-email?token=${encodeURIComponent(token)}`;
  const safeName = escapeHtml(name);
  const safeLink = escapeHtml(link);
  await send(
    email,
    'Confirme seu e-mail no RADAR',
    `Ola, ${name}.\n\nConfirme seu e-mail acessando: ${link}\n\nO link expira em 24 horas.`,
    `<p>Ola, ${safeName}.</p><p>Confirme seu e-mail no RADAR:</p><p><a href="${safeLink}">Confirmar e-mail</a></p><p>O link expira em 24 horas.</p>`,
  );
}

export async function sendPasswordResetEmail(email: string, name: string, token: string): Promise<void> {
  const link = `${publicBaseUrl()}/#/reset-password?token=${encodeURIComponent(token)}`;
  const safeName = escapeHtml(name);
  const safeLink = escapeHtml(link);
  await send(
    email,
    'Redefinicao de senha - RADAR',
    `Ola, ${name}.\n\nRedefina sua senha acessando: ${link}\n\nO link expira em 1 hora. Se voce nao solicitou, ignore esta mensagem.`,
    `<p>Ola, ${safeName}.</p><p>Redefina sua senha no RADAR:</p><p><a href="${safeLink}">Redefinir senha</a></p><p>O link expira em 1 hora. Se voce nao solicitou, ignore esta mensagem.</p>`,
  );
}

export async function trySendVerificationEmail(
  email: string,
  name: string,
  token: string,
): Promise<boolean> {
  try {
    await sendVerificationEmail(email, name, token);
    return true;
  } catch (error) {
    logger.warn({ err: error, emailConfigured: isEmailConfigured() }, 'Nao foi possivel enviar e-mail de verificacao');
    return false;
  }
}

export function assertEmailConfigured(): void {
  if (!isEmailConfigured()) {
    throw new AppError(
      503,
      'EMAIL_NOT_CONFIGURED',
      'Servico de e-mail nao configurado. A recuperacao de senha e a verificacao de e-mail exigem SMTP configurado.',
    );
  }
}
