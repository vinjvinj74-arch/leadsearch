import type { NextFunction, Request, Response } from 'express';
import { forbidden, unauthorized } from '../lib/errors.js';
import { SUPER_ADMIN_ROLE } from '../plans.js';
import {
  assertActiveSubscription,
  assertCanSearch,
  getEntitlements,
  type Entitlements,
} from '../services/subscriptionService.js';

/**
 * Carrega os direitos de acesso diretamente do banco.
 * Nunca confia em plano, saldo ou papel enviados pelo cliente.
 */
export async function loadEntitlements(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    if (!req.user) {
      next(unauthorized());
      return;
    }
    req.entitlements = await getEntitlements(req.user.id, req.user.role);
    next();
  } catch (error) {
    next(error);
  }
}

export function entitlementsFor(req: Request): Entitlements {
  if (!req.entitlements) {
    throw unauthorized('Sessao invalida.');
  }
  return req.entitlements;
}

/** Exige assinatura ativa (ou super admin) para operacoes com custo externo. */
export function requireToolAccess(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!req.user) throw unauthorized();
    if (!req.entitlements) {
      next(unauthorized('Sessao invalida.'));
      return;
    }
    assertActiveSubscription(req.entitlements);
    next();
  } catch (error) {
    next(error);
  }
}

/** Exige assinatura ativa e saldo de creditos para executar uma pesquisa. */
export function requireSearchAccess(req: Request, _res: Response, next: NextFunction): void {
  try {
    if (!req.user) throw unauthorized();
    if (!req.entitlements) {
      next(unauthorized('Sessao invalida.'));
      return;
    }
    assertCanSearch(req.entitlements);
    next();
  } catch (error) {
    next(error);
  }
}

/** Apenas o super administrador provisionado no servidor. */
export function requireSuperAdmin(req: Request, _res: Response, next: NextFunction): void {
  if (!req.user || !req.authSession) {
    next(unauthorized());
    return;
  }
  if (req.user.role !== SUPER_ADMIN_ROLE) {
    next(forbidden('Acesso restrito ao administrador.'));
    return;
  }
  next();
}
