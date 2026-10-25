import type { WebsiteStatus } from '../config.js';

export interface ScoreWeights {
  confirmedNoWebsite: number;
  websiteProblems: number;
  phone: number;
  email: number;
  activeBusiness: number;
  nichePotential: number;
  limitedPresence: number;
  actionableInfo: number;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
  confirmedNoWebsite: 30,
  websiteProblems: 20,
  phone: 15,
  email: 15,
  activeBusiness: 10,
  nichePotential: 10,
  limitedPresence: 10,
  actionableInfo: 5,
};

export const WEIGHT_LIMITS: Record<keyof ScoreWeights, number> = {
  confirmedNoWebsite: 50,
  websiteProblems: 40,
  phone: 30,
  email: 30,
  activeBusiness: 25,
  nichePotential: 25,
  limitedPresence: 25,
  actionableInfo: 15,
};

export interface ScoreReason {
  code: string;
  label: string;
  points: number;
}

export interface ScoreInput {
  websiteStatus: WebsiteStatus;
  hasWebsite: boolean;
  hasHttps: boolean | null;
  phone: string | null;
  email: string | null;
  businessStatus: string | null;
  reviewsCount: number | null;
  segment: string | null;
  hasAddress: boolean;
  hasGoogleCategory: boolean;
}

export interface ScoreResult {
  score: number;
  reasons: ScoreReason[];
}

export const POTENTIAL_SEGMENTS = [
  'clinica',
  'estetica',
  'odonto',
  'dentista',
  'oficina',
  'mecanica',
  'ar condicionado',
  'climatizacao',
  'marcenaria',
  'advocacia',
  'advogado',
  'contabilidade',
  'imobiliaria',
  'academia',
  'restaurante',
  'padaria',
  'salao',
  'barbearia',
  'pet',
  'veterinaria',
  'hotel',
  'pousada',
  'construtora',
  'arquitetura',
  'fisioterapia',
  'psicologo',
  'nutricionista',
  'escola',
  'curso',
  'loja',
  'distribuidora',
];

export function sanitizeWeights(input: unknown): ScoreWeights {
  const source = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const weights = { ...DEFAULT_WEIGHTS };
  (Object.keys(DEFAULT_WEIGHTS) as Array<keyof ScoreWeights>).forEach((key) => {
    const value = Number(source[key]);
    if (Number.isFinite(value)) {
      weights[key] = Math.max(0, Math.min(Math.round(value), WEIGHT_LIMITS[key]));
    }
  });
  return weights;
}

export function computeScore(input: ScoreInput, customWeights?: Partial<ScoreWeights>): ScoreResult {
  const weights = { ...DEFAULT_WEIGHTS, ...(customWeights ?? {}) };
  const reasons: ScoreReason[] = [];

  if (input.websiteStatus === 'missing') {
    reasons.push({
      code: 'no_website',
      label: 'Ausencia de site proprio confirmada',
      points: weights.confirmedNoWebsite,
    });
  } else if (input.hasWebsite && ['offline', 'error'].includes(input.websiteStatus)) {
    reasons.push({
      code: 'website_problem',
      label: 'Site com falha de disponibilidade',
      points: weights.websiteProblems,
    });
  } else if (input.websiteStatus === 'online' && input.hasHttps === false) {
    reasons.push({
      code: 'no_https',
      label: 'Site online sem HTTPS',
      points: Math.round(weights.websiteProblems / 2),
    });
  }

  if (input.phone) {
    reasons.push({ code: 'phone', label: 'Telefone comercial disponivel', points: weights.phone });
  }
  if (input.email) {
    reasons.push({ code: 'email', label: 'E-mail comercial publicado', points: weights.email });
  }
  if ((input.businessStatus ?? '').toUpperCase() === 'OPERATIONAL') {
    reasons.push({ code: 'active', label: 'Atividade empresarial aparente', points: weights.activeBusiness });
  }

  const segment = (input.segment ?? '').toLowerCase();
  if (POTENTIAL_SEGMENTS.some((term) => segment.includes(term))) {
    reasons.push({
      code: 'segment',
      label: 'Segmento com potencial para servicos digitais',
      points: weights.nichePotential,
    });
  }

  if (input.hasWebsite && input.reviewsCount !== null && input.reviewsCount >= 0 && input.reviewsCount < 15) {
    reasons.push({
      code: 'limited_presence',
      label: 'Presenca digital limitada (poucas avaliacoes publicas)',
      points: weights.limitedPresence,
    });
  }

  if (input.hasAddress || input.hasGoogleCategory || input.phone || input.email) {
    reasons.push({
      code: 'actionable',
      label: 'Informacoes suficientes para personalizar a abordagem',
      points: weights.actionableInfo,
    });
  }

  const score = Math.max(0, Math.min(100, reasons.reduce((total, reason) => total + reason.points, 0)));
  return { score, reasons };
}
