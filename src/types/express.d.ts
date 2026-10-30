import type { AuthSession, AuthUser } from './session.js';
import type { Entitlements } from '../services/subscriptionService.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      authSession?: AuthSession;
      entitlements?: Entitlements;
      requestId: string;
      clientIpHash?: string;
    }
  }
}

export {};
