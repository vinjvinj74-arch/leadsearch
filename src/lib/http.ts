import { createHash } from 'node:crypto';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { config } from '../config.js';

export function asyncHandler(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function hashIp(ip: string | undefined): string {
  return createHash('sha256').update(`${config.sessionSecret}:${ip ?? 'unknown'}`).digest('hex').slice(0, 32);
}

export function requestIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

export function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

export function parsePage(value: unknown, fallback = 1): number {
  return clampInt(value, fallback, 1, 100000);
}

export function parsePageSize(value: unknown, fallback = 25): number {
  return clampInt(value, fallback, 1, 100);
}
