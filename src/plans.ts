/**
 * Fonte unica de verdade dos planos comerciais do RADAR.
 *
 * Precos e creditos ficam exclusivamente no backend. O frontend apenas
 * apresenta os valores devolvidos por /api/billing/plans e nunca decide
 * acesso, saldo ou permissao.
 */

export const ADMIN_EMAIL = 'vinjvinj74@gmail.com';
export const SUPER_ADMIN_ROLE = 'super_admin' as const;

export type UserRole = 'user' | typeof SUPER_ADMIN_ROLE;
export type PlanId = 'starter' | 'pro' | 'business';

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Preco mensal em centavos de BRL. */
  priceCents: number;
  /** Rotulo pronto em pt-BR, sem espaco especial. */
  priceLabel: string;
  /** Creditos concedidos a cada periodo mensal. */
  credits: number;
  creditsLabel: string;
  description: string;
  features: string[];
  highlight: boolean;
  sortOrder: number;
}

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  minimumFractionDigits: 2,
});

const integer = new Intl.NumberFormat('pt-BR');

export function formatBRL(cents: number): string {
  return brl.format(cents / 100).replace(/\u00a0/g, ' ');
}

export function formatCredits(credits: number): string {
  return integer.format(credits);
}

function buildPlan(
  id: PlanId,
  name: string,
  priceCents: number,
  credits: number,
  description: string,
  features: string[],
  highlight = false,
  sortOrder = 0,
): PlanDefinition {
  return {
    id,
    name,
    priceCents,
    priceLabel: formatBRL(priceCents),
    credits,
    creditsLabel: `${formatCredits(credits)} créditos mensais`,
    description,
    features,
    highlight,
    sortOrder,
  };
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  starter: buildPlan(
    'starter',
    'Starter',
    3990,
    300,
    'Para quem está começando a prospectar com constância.',
    [
      'Pesquisa de empresas por nicho e localização',
      'Até 5 empresas por pesquisa',
      'Mapa, filtros geográficos e pontuação explicável',
      'CRM com histórico de atividades',
      'Enriquecimento de contatos públicos',
      'Exportação CSV',
    ],
    false,
    1,
  ),
  pro: buildPlan(
    'pro',
    'Pro',
    6700,
    1000,
    'Para rotinas comerciais com volume maior de prospecção.',
    [
      'Tudo do Starter',
      '1.000 créditos por mês',
      'Histórico completo de pesquisas',
      'Filtros avançados no Radar',
      'Exportação CSV com campos personalizados',
      'Enriquecimento de contatos públicos',
    ],
    true,
    2,
  ),
  business: buildPlan(
    'business',
    'Business',
    19700,
    5000,
    'Para operações que precisam de alto volume de pesquisas.',
    [
      'Tudo do Pro',
      '5.000 créditos por mês',
      'Volume ampliado de prospecção',
      'Histórico completo de pesquisas',
      'Exportação CSV com campos personalizados',
      'Suporte por e-mail',
    ],
    false,
    3,
  ),
};

export const PLAN_LIST: PlanDefinition[] = Object.values(PLANS).sort(
  (a, b) => a.sortOrder - b.sortOrder,
);

export const PLAN_IDS = PLAN_LIST.map((plan) => plan.id) as PlanId[];

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PLANS, value);
}

export function getPlan(planId: string | null | undefined): PlanDefinition | null {
  if (!planId || !isPlanId(planId)) return null;
  return PLANS[planId];
}

export function isSuperAdminEmail(email: string | null | undefined): boolean {
  return Boolean(email) && String(email).trim().toLowerCase() === ADMIN_EMAIL;
}

/** Normaliza qualquer papel legado para o modelo atual. */
export function normalizeRole(role: string | null | undefined): UserRole {
  return role === SUPER_ADMIN_ROLE ? SUPER_ADMIN_ROLE : 'user';
}

/** Uma unidade de credito equivale a uma pesquisa efetivamente iniciada. */
export const CREDIT_UNIT_DESCRIPTION =
  'Cada pesquisa executada consome 1 crédito. Abrir dashboards, navegar, filtrar ou exportar não consome créditos.';

export interface PlanComparisonRow {
  label: string;
  values: Record<PlanId, string>;
}

export const PLAN_COMPARISON: PlanComparisonRow[] = [
  {
    label: 'Preço mensal',
    values: {
      starter: PLANS.starter.priceLabel,
      pro: PLANS.pro.priceLabel,
      business: PLANS.business.priceLabel,
    },
  },
  {
    label: 'Créditos por mês',
    values: {
      starter: formatCredits(PLANS.starter.credits),
      pro: formatCredits(PLANS.pro.credits),
      business: formatCredits(PLANS.business.credits),
    },
  },
  {
    label: 'Pesquisas por mês (1 crédito cada)',
    values: {
      starter: formatCredits(PLANS.starter.credits),
      pro: formatCredits(PLANS.pro.credits),
      business: formatCredits(PLANS.business.credits),
    },
  },
  {
    label: 'Empresas por pesquisa',
    values: { starter: 'Até 5', pro: 'Até 5', business: 'Até 5' },
  },
  {
    label: 'Mapa, filtros e pontuação',
    values: { starter: 'Incluído', pro: 'Incluído', business: 'Incluído' },
  },
  {
    label: 'CRM e histórico de atividades',
    values: { starter: 'Incluído', pro: 'Incluído', business: 'Incluído' },
  },
  {
    label: 'Exportação CSV',
    values: { starter: 'Incluído', pro: 'Incluído', business: 'Incluído' },
  },
  {
    label: 'Enriquecimento de contatos públicos',
    values: { starter: 'Incluído', pro: 'Incluído', business: 'Incluído' },
  },
  {
    label: 'Renovação dos créditos',
    values: { starter: 'Mensal', pro: 'Mensal', business: 'Mensal' },
  },
];
