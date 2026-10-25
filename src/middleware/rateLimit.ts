import rateLimit from 'express-rate-limit';
import type { Request } from 'express';

function jsonHandler(message: string) {
  return (_req: Request, res: import('express').Response) => {
    res.status(429).json({ error: { code: 'RATE_LIMITED', message } });
  };
}

export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler('Muitas tentativas de autenticacao. Aguarde alguns minutos e tente novamente.'),
});

export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: jsonHandler('Limite de requisicoes excedido. Aguarde alguns minutos.'),
});

export const searchLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 30,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
  handler: jsonHandler('Limite de pesquisas por hora excedido. Aguarde antes de realizar novas consultas.'),
});

export const exportLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req: Request) => req.user?.id ?? req.ip ?? 'anon',
  handler: jsonHandler('Limite de exportacoes excedido. Aguarde alguns minutos.'),
});
