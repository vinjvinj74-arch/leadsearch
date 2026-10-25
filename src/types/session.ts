export interface AuthUser {
  id: string;
  name: string;
  email: string;
  emailVerifiedAt: string | null;
  createdAt: string;
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
