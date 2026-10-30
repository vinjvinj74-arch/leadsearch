import type { PlanId, UserRole } from '../plans.js';
import type { AccessReason, SubscriptionStatus } from '../services/subscriptionService.js';

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerifiedAt: string | null;
  createdAt: string;
  role: UserRole;
  isSuperAdmin: boolean;
  planId: PlanId | null;
  planName: string | null;
  planStatus: SubscriptionStatus | null;
  creditsLimit: number;
  creditsUsed: number;
  creditsRemaining: number;
  canSearch: boolean;
  active: boolean;
  unlimited: boolean;
  accessReason: AccessReason;
  renewsAt: string | null;
  provider: string | null;
  providerCustomerId: string | null;
  creditUnit: string;
  needsUpgrade: boolean;
}

export interface AuthSession {
  id: string;
  userId: string;
}

export interface UserSettingsRecord {
  theme: 'light' | 'dark' | 'system';
  defaultCity: string | null;
  defaultState: string | null;
  defaultCountry: string;
  defaultNiche: string | null;
  defaultLimit: number;
  favoriteNiches: string[];
  exportFields: string[];
  scoreWeights: Record<string, number> | null;
  allowEnrichment: boolean;
  retentionDays: number;
}
