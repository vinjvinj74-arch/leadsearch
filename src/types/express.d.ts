import type { AuthSession, AuthUser } from './session.js';

declare global {
  namespace Express {
    interface Request {
      user?: AuthUser;
      authSession?: AuthSession;
      requestId: string;
      clientIpHash?: string;
    }
  }
}

export {};
