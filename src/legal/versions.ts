export const LEGAL_VERSION = '2026-10-30';
export const LEGAL_CONTACT_EMAIL = 'vinjvinj74@gmail.com';

export interface LegalDocument {
  id: string;
  title: string;
  route: string;
  routeEn: string;
  version: string;
  requiredOnRegistration: boolean;
}

export const LEGAL_DOCUMENTS: LegalDocument[] = [
  {
    id: 'terms',
    title: 'Termos de Uso',
    route: '/termos',
    routeEn: '/terms',
    version: LEGAL_VERSION,
    requiredOnRegistration: true,
  },
  {
    id: 'privacy',
    title: 'Politica de Privacidade',
    route: '/privacidade',
    routeEn: '/privacy',
    version: LEGAL_VERSION,
    requiredOnRegistration: true,
  },
  {
    id: 'lgpd',
    title: 'Direitos LGPD',
    route: '/lgpd',
    routeEn: '/lgpd-rights',
    version: LEGAL_VERSION,
    requiredOnRegistration: true,
  },
  {
    id: 'cookies',
    title: 'Politica de Cookies',
    route: '/politicas/cookies',
    routeEn: '/cookies',
    version: LEGAL_VERSION,
    requiredOnRegistration: false,
  },
  {
    id: 'security',
    title: 'Politica de Seguranca',
    route: '/politicas/seguranca',
    routeEn: '/security-policy',
    version: LEGAL_VERSION,
    requiredOnRegistration: false,
  },
  {
    id: 'acceptable_use',
    title: 'Politica de Uso Aceitavel',
    route: '/politicas/uso-aceitavel',
    routeEn: '/acceptable-use',
    version: LEGAL_VERSION,
    requiredOnRegistration: false,
  },
  {
    id: 'refund_policy',
    title: 'Politica de Reembolso',
    route: '/politicas/reembolso',
    routeEn: '/refund-policy',
    version: LEGAL_VERSION,
    requiredOnRegistration: false,
  },
  {
    id: 'data_deletion',
    title: 'Exclusao de Dados',
    route: '/exclusao-de-dados',
    routeEn: '/data-deletion',
    version: LEGAL_VERSION,
    requiredOnRegistration: false,
  },
  {
    id: 'contact',
    title: 'Contato',
    route: '/contato',
    routeEn: '/contact',
    version: LEGAL_VERSION,
    requiredOnRegistration: false,
  },
];

export type LegalDocumentId = (typeof LEGAL_DOCUMENTS)[number]['id'];

export const REQUIRED_REGISTRATION_DOCUMENTS = LEGAL_DOCUMENTS.filter(
  (document) => document.requiredOnRegistration,
).map((document) => document.id);
