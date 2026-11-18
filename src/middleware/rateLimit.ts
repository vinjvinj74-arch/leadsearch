import rateLimit, { type IncrementResponse, type Options, type Store } from 'express-rate-limit';
import type { Request } from 'express';
import { recordAudit } from '../lib/audit.js';

type HitInfo = { totalHits: number; resetTime: Date };

/** Store em memória sem setInterval (não permitido no escopo global do Workers). */
class WorkerMemoryStore implements Store {
  private readonly hits = new Map<string, HitInfo>();
  private windowMs = 60_000;

  init(options: Options): void {
    this.windowMs = options.windowMs;
  }

  async get(key: string): Promise<HitInfo | undefined> {
    this.evictExpired();
    return this.hits.get(key);
  }

  async increment(key: string): Promise<IncrementResponse> {
    this.evictExpired();
    const now = Date.now();
    let info = this.hits.get(key);
    if (!info || info.resetTime.getTime() <= now) {
      info = { totalHits: 0, resetTime: new Date(now + this.windowMs) };
      this.hits.set(key, info);
    }
    info.totalHits += 1;
    return { totalHits: info.totalHits, resetTime: info.resetTime };
  }

  async decrement(key: string): Promise<void> {
    const info = this.hits.get(key);
    if (info) info.totalHits = Math.max(0, info.totalHits - 1);
  }

  async resetKey(key: string): Promise<void> {
    this.hits.delete(key);
  }

  async resetAll(): Promise<void> {
    this.hits.clear();
  }

  private evictExpired(): void {
    const now = Date.now();
    for (const [key, info] of this.hits) {
      if (info.resetTime.getTime() <= now) this.hits.delete(key);
    }
  }
}

function jsonHandler(message: string, auditAction?: string) {
  return (req: Request, res: import('express').Response) => {
    if (auditAction) {
      recordAudit(req, auditAction, null, null, { path: req.path, method: req.method });
    }
    res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
  };
}

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler(
    'Muitas tentativas de autenticacao. Aguarde alguns minutos e tente novamente.',
    'rate_limited_auth',
  ),
});

export const registerLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler(
    'Muitas tentativas de cadastro. Aguarde antes de tentar novamente.',
    'rate_limited_register',
  ),
});

export const forgotPasswordLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 5,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler(
    'Muitas solicitacoes de recuperacao. Aguarde antes de tentar novamente.',
    'rate_limited_password_reset',
  ),
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler('Limite de requisicoes excedido. Aguarde alguns minutos.'),
});

export const searchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
  handler: jsonHandler('Limite de pesquisas por hora excedido. Aguarde antes de realizar novas consultas.'),
});

export const geocodeLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 120,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
  handler: jsonHandler('Muitas consultas de localizacao. Aguarde alguns instantes.'),
});

export const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
  handler: jsonHandler('Limite de exportacoes excedido. Aguarde alguns minutos.'),
});

export const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
  handler: jsonHandler(
    'Muitas solicitações de contato. Aguarde antes de enviar outra mensagem.',
    'rate_limited_contact',
  ),
});

export const mutationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  store: new WorkerMemoryStore(),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
  handler: jsonHandler('Muitas alteracoes em pouco tempo. Aguarde alguns minutos.', 'rate_limited_mutation'),
});
