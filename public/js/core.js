export const LEAD_STATUSES = [
  'novo',
  'qualificado',
  'contatado',
  'aguardando_resposta',
  'respondeu',
  'reuniao_agendada',
  'proposta_enviada',
  'em_negociacao',
  'vendido',
  'perdido',
  'nao_contatar',
];

export const STATUS_LABELS = {
  novo: 'Novo',
  qualificado: 'Qualificado',
  contatado: 'Contatado',
  aguardando_resposta: 'Aguardando resposta',
  respondeu: 'Respondeu',
  reuniao_agendada: 'Reunião agendada',
  proposta_enviada: 'Proposta enviada',
  em_negociacao: 'Em negociação',
  vendido: 'Vendido',
  perdido: 'Perdido',
  nao_contatar: 'Não contatar',
};

export const WEBSITE_STATUSES = ['unknown', 'missing', 'online', 'offline', 'redirect', 'error'];

export const WEBSITE_LABELS = {
  unknown: 'Não verificado',
  missing: 'Sem site',
  online: 'Online',
  offline: 'Offline',
  redirect: 'Redireciona',
  error: 'Erro',
};

export const SEARCH_STATUS_LABELS = {
  pending: 'Na fila',
  running: 'Buscando empresas',
  enriching: 'Enriquecendo contatos',
  completed: 'Concluída',
  failed: 'Falhou',
};

export const ACTIVITY_LABELS = {
  note: 'Nota',
  contact: 'Contato',
  meeting: 'Reunião',
  proposal: 'Proposta',
  result: 'Resultado',
  status_change: 'Status alterado',
  site_check: 'Verificação de site',
  enrichment: 'Enriquecimento',
  do_not_contact: 'Não contatar',
};

export const ACTIVITY_TYPES = [
  ['note', 'Nota'],
  ['contact', 'Contato realizado'],
  ['meeting', 'Reunião'],
  ['proposal', 'Proposta enviada'],
  ['result', 'Resultado'],
];

export const SOURCE_LABELS = {
  apify_google_maps: 'Apify Google Maps',
  google_places: 'Google Places',
  website_enrichment: 'Enriquecimento do site',
  website_check: 'Verificação do site',
};

export const EXPORT_FIELDS = [
  ['name', 'Empresa'],
  ['segment', 'Segmento'],
  ['city', 'Cidade'],
  ['state', 'UF'],
  ['country', 'País'],
  ['phone', 'Telefone'],
  ['email', 'E-mail'],
  ['website', 'Site'],
  ['website_status', 'Situação do site'],
  ['score', 'Pontuação'],
  ['status', 'Status comercial'],
  ['address', 'Endereço'],
  ['google_maps_url', 'Google Maps'],
  ['last_checked_at', 'Última verificação'],
  ['created_at', 'Criado em'],
  ['source', 'Origem'],
];

export const WEIGHT_FIELDS = [
  ['confirmedNoWebsite', 'Sem site confirmado', 50],
  ['websiteProblems', 'Problemas no site', 40],
  ['phone', 'Telefone disponível', 30],
  ['email', 'E-mail disponível', 30],
  ['activeBusiness', 'Negócio ativo', 25],
  ['nichePotential', 'Potencial do nicho', 25],
  ['limitedPresence', 'Presença digital limitada', 25],
  ['actionableInfo', 'Informação acionável', 15],
];

export const DEFAULT_WEIGHTS = {
  confirmedNoWebsite: 30,
  websiteProblems: 20,
  phone: 15,
  email: 15,
  activeBusiness: 10,
  nichePotential: 10,
  limitedPresence: 10,
  actionableInfo: 5,
};

export const ROUTES = {
  dashboard: { title: 'Dashboard', subtitle: 'Visão geral da sua prospecção.' },
  search: { title: 'Prospecção', subtitle: 'Encontre empresas e enriqueça contatos com dados públicos.' },
  leads: { title: 'Leads', subtitle: 'Filtre, qualifique e acompanhe cada oportunidade.' },
  settings: { title: 'Configurações', subtitle: 'Preferências, integrações e segurança da conta.' },
};

export const DEFAULT_FILTERS = {
  q: '',
  status: '',
  websiteStatus: '',
  hasWebsite: '',
  minScore: '',
  sort: 'created_at',
  order: 'desc',
  searchId: '',
};

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const dom = {
  auth: document.getElementById('auth-view'),
  shell: document.getElementById('app-shell'),
  main: document.getElementById('main-view'),
  modal: document.getElementById('modal-root'),
  toast: document.getElementById('toast-region'),
  pageTitle: document.getElementById('page-title'),
  pageSubtitle: document.getElementById('page-subtitle'),
  mapsBadge: document.getElementById('maps-badge'),
  userName: document.getElementById('user-name'),
  userEmail: document.getElementById('user-email'),
  userAvatar: document.getElementById('user-avatar'),
  sidebar: document.getElementById('sidebar'),
  overlay: document.getElementById('mobile-overlay'),
  logout: document.getElementById('logout-button'),
  menuToggle: document.getElementById('menu-toggle'),
  themeMeta: document.querySelector('meta[name="theme-color"]'),
};

export const state = {
  user: null,
  settings: null,
  integrations: null,
  csrf: null,
  route: 'dashboard',
  themePreference: 'system',
  authToken: null,
  leads: {
    filters: { ...DEFAULT_FILTERS },
    page: 1,
    pageSize: 25,
    data: null,
    selected: new Set(),
    loading: false,
    seq: 0,
  },
  activeSearch: null,
  activeStats: null,
  searchTimer: null,
  searchHistory: null,
  settingsTab: 'profile',
  settingsCache: { integrations: null, diagnostics: null, sessions: null },
  modalLeadId: null,
  modalLead: null,
  modalEditing: false,
  modalBusy: false,
};

export class ApiError extends Error {
  constructor(message, status, code, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

export function nl2br(value) {
  return esc(value).replace(/\r?\n/g, '<br>');
}

export function safeUrl(value) {
  if (!value) return null;
  try {
    const url = new URL(String(value), window.location.origin);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.href;
  } catch {
    return null;
  }
}

export function externalLink(url, label, extra = '') {
  const safe = safeUrl(url);
  if (!safe) return '—';
  return `<a href="${esc(safe)}" target="_blank" rel="noopener noreferrer" ${extra}>${esc(label)}</a>`;
}

export function hostname(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url || '';
  }
}

export function fmtNumber(value) {
  const number = Number(value ?? 0);
  return new Intl.NumberFormat('pt-BR').format(Number.isFinite(number) ? number : 0);
}

export function fmtDate(value, withTime = false) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    ...(withTime ? { hour: '2-digit', minute: '2-digit' } : {}),
  }).format(date);
}

export function fmtRelative(value) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  const diff = Date.now() - date.getTime();
  const minutes = Math.round(diff / 60000);
  if (Math.abs(minutes) < 1) return 'agora';
  if (Math.abs(minutes) < 60) return `há ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (Math.abs(hours) < 24) return `há ${hours} h`;
  const days = Math.round(hours / 24);
  if (Math.abs(days) < 7) return `há ${days} d`;
  return fmtDate(value);
}

export function localInputValue(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const offset = date.getTimezoneOffset();
  return new Date(date.getTime() - offset * 60000).toISOString().slice(0, 16);
}

export function initials(name) {
  return (
    String(name || 'LS')
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') || 'LS'
  );
}

export function option(value, label, current) {
  return `<option value="${esc(value)}"${String(value) === String(current) ? ' selected' : ''}>${esc(label)}</option>`;
}

export function statusBadge(status) {
  return `<span class="status-badge status-${esc(status)}">${esc(STATUS_LABELS[status] ?? status)}</span>`;
}

export function websiteBadge(status) {
  const map = {
    unknown: '',
    missing: 'badge-warning',
    online: 'badge-success',
    offline: 'badge-danger',
    redirect: 'badge-warning',
    error: 'badge-danger',
  };
  return `<span class="badge ${map[status] ?? ''}">${esc(WEBSITE_LABELS[status] ?? status)}</span>`;
}

export function scorePill(score) {
  const value = Math.round(Number(score ?? 0));
  const cls = value >= 70 ? 'score-high' : value >= 40 ? 'score-mid' : 'score-low';
  return `<span class="score-pill ${cls}">${value}</span>`;
}

export function pageSkeleton(kind) {
  if (kind === 'leads') {
    return `
      <div class="stack">
        <div class="skeleton skeleton-panel" style="height: 120px"></div>
        <div class="skeleton skeleton-panel" style="height: 420px"></div>
      </div>`;
  }
  if (kind === 'settings') {
    return `
      <div class="settings-layout">
        <div class="skeleton" style="height: 220px"></div>
        <div class="skeleton skeleton-panel"></div>
      </div>`;
  }
  return `
    <div class="stack">
      <div class="skeleton-stats">
        ${Array.from({ length: 4 }, () => '<div class="skeleton skeleton-card"></div>').join('')}
      </div>
      <div class="grid-2">
        <div class="skeleton skeleton-panel"></div>
        <div class="skeleton skeleton-panel"></div>
      </div>
    </div>`;
}

export function emptyState(title, description, actionHtml = '') {
  return `
    <div class="empty-state">
      <span class="empty-icon" aria-hidden="true">LS</span>
      <h3>${esc(title)}</h3>
      <p>${esc(description)}</p>
      ${actionHtml}
    </div>`;
}

export function readCookie(name) {
  return (
    document.cookie
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => part.split('='))
      .find(([key]) => key === name)?.[1] ?? null
  );
}

export async function ensureCsrf(force = false) {
  if (!force) {
    const cookie = readCookie('ls_csrf');
    if (cookie) {
      state.csrf = decodeURIComponent(cookie);
      return state.csrf;
    }
    if (state.csrf) return state.csrf;
  }
  const response = await fetch('/api/auth/csrf', {
    method: 'GET',
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
  });
  if (!response.ok) throw new Error('Não foi possível iniciar a proteção CSRF.');
  const data = await response.json();
  const cookie = readCookie('ls_csrf');
  state.csrf = data.csrfToken || (cookie ? decodeURIComponent(cookie) : null);
  return state.csrf;
}

async function parseResponse(response) {
  const type = response.headers.get('content-type') ?? '';
  if (type.includes('application/json')) {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  const text = await response.text();
  try {
    return JSON.parse(text);
  } catch {
    return text ? { error: { message: text } } : null;
  }
}

export async function api(path, options = {}) {
  const method = (options.method ?? 'GET').toUpperCase();
  const headers = new Headers(options.headers ?? {});
  headers.set('Accept', 'application/json');

  let body = options.body;
  if (body !== undefined && body !== null && !(body instanceof FormData)) {
    headers.set('Content-Type', 'application/json');
    body = JSON.stringify(body);
  }

  if (!SAFE_METHODS.has(method)) {
    const token = await ensureCsrf();
    if (token) headers.set('X-CSRF-Token', token);
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body,
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError('Não foi possível conectar ao servidor. Verifique sua conexão.', 0, 'NETWORK_ERROR');
  }

  const payload = await parseResponse(response);

  if (response.status === 403 && payload?.error?.code === 'CSRF_INVALID' && !options.retriedCsrf) {
    await ensureCsrf(true);
    return api(path, { ...options, retriedCsrf: true });
  }

  if (!response.ok) {
    const error = payload?.error ?? {};
    if (response.status === 401 && state.user && !path.startsWith('/api/auth/login')) {
      window.dispatchEvent(new CustomEvent('auth:expired'));
    }
    throw new ApiError(
      error.message || 'Não foi possível concluir a operação.',
      response.status,
      error.code || 'REQUEST_FAILED',
      error.details,
    );
  }

  return payload;
}

export function errorMessage(error) {
  if (error instanceof ApiError) {
    if (error.code === 'INTEGRATION_NOT_CONFIGURED') {
      return 'Integração não configurada no servidor. Um administrador precisa definir as variáveis de ambiente necessárias.';
    }
    if (error.code === 'EMAIL_NOT_CONFIGURED') {
      return 'O envio de e-mails não está configurado no servidor. Defina SMTP_HOST e SMTP_FROM para habilitar este recurso.';
    }
    if (Array.isArray(error.details) && error.details.length) {
      const first = error.details[0];
      if (first?.message) return `${error.message} ${first.message}`;
    }
    return error.message;
  }
  if (error instanceof TypeError) return 'Não foi possível conectar ao servidor.';
  return error?.message || 'Erro inesperado. Tente novamente.';
}

export function toast(message, type = 'info', timeout = 5200) {
  if (!dom.toast) return;
  const element = document.createElement('div');
  element.className = `toast toast-${type}`;
  element.setAttribute('role', type === 'error' ? 'alert' : 'status');
  element.textContent = message;
  element.addEventListener('click', () => element.remove());
  dom.toast.appendChild(element);
  window.setTimeout(() => {
    element.classList.add('is-leaving');
    window.setTimeout(() => element.remove(), 180);
  }, timeout);
}

export function clearFormMessages(form) {
  form.querySelectorAll('.form-error, .form-success').forEach((element) => {
    element.textContent = '';
    element.hidden = true;
  });
}

export function showFormError(form, message) {
  const inline = form.querySelector('[data-form-error]') ?? form.querySelector('.form-error');
  if (inline) {
    inline.textContent = message;
    inline.hidden = false;
    return;
  }
  const section = form.closest('.auth-section');
  const authError = section?.querySelector('[data-error-for]');
  if (authError) {
    authError.textContent = message;
    authError.hidden = false;
    return;
  }
  toast(message, 'error');
}

export function showFormSuccess(form, message) {
  const inline = form.querySelector('.form-success');
  if (inline) {
    inline.textContent = message;
    inline.hidden = false;
    return;
  }
  toast(message, 'success');
}

export function setFormBusy(form, busy, label = 'Aguarde...') {
  const submit = form.querySelector('button[type="submit"]');
  if (!submit) return;
  if (busy) {
    submit.dataset.originalLabel = submit.textContent;
    submit.textContent = label;
    submit.disabled = true;
    form.setAttribute('aria-busy', 'true');
  } else {
    submit.textContent = submit.dataset.originalLabel || submit.textContent;
    submit.disabled = false;
    form.removeAttribute('aria-busy');
  }
}

export function applyTheme(preference, persist = true) {
  const valid = ['light', 'dark', 'system'].includes(preference) ? preference : 'system';
  state.themePreference = valid;
  const resolved =
    valid === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : valid;
  document.documentElement.dataset.theme = resolved;
  if (dom.themeMeta) dom.themeMeta.content = resolved === 'light' ? '#f5f6f8' : '#08090b';
  if (persist) localStorage.setItem('leadsearch-theme', valid);
}

export function mapsConfigured() {
  const integrations = state.integrations;
  if (!integrations) return null;
  if (typeof integrations.discoveryConfigured === 'boolean') return integrations.discoveryConfigured;
  if (typeof integrations.googleMapsConfigured === 'boolean') return integrations.googleMapsConfigured;
  if (integrations.discovery && typeof integrations.discovery.configured === 'boolean') {
    return integrations.discovery.configured;
  }
  return null;
}

export function emailConfigured() {
  const integrations = state.integrations;
  if (!integrations) return null;
  if (typeof integrations.emailConfigured === 'boolean') return integrations.emailConfigured;
  if (integrations.email && typeof integrations.email.configured === 'boolean')
    return integrations.email.configured;
  return null;
}

export function paintMapsBadge() {
  if (!dom.mapsBadge) return;
  const configured = mapsConfigured();
  dom.mapsBadge.className = 'badge';
  if (configured === true) {
    dom.mapsBadge.classList.add('badge-success');
    dom.mapsBadge.textContent = 'Descoberta: ativa';
    dom.mapsBadge.title = 'Fonte de descoberta de empresas configurada no servidor.';
  } else if (configured === false) {
    dom.mapsBadge.classList.add('badge-warning');
    dom.mapsBadge.textContent = 'Descoberta: pendente';
    dom.mapsBadge.title = 'Defina APIFY_API_TOKEN no servidor para habilitar pesquisas reais.';
  } else {
    dom.mapsBadge.textContent = 'Descoberta: verificando';
    dom.mapsBadge.title = 'Consultando o estado da integração.';
  }
}

export function paintUser() {
  if (!state.user) return;
  dom.userName.textContent = state.user.name;
  dom.userEmail.textContent = state.user.email;
  dom.userAvatar.textContent = initials(state.user.name);
}

export function paintRoute() {
  const route = ROUTES[state.route] ?? ROUTES.dashboard;
  dom.pageTitle.textContent = route.title;
  dom.pageSubtitle.textContent = route.subtitle;
  document.title = `${route.title} · LeadSearch`;
  document.querySelectorAll('.nav-link[data-route]').forEach((link) => {
    const active = link.dataset.route === state.route;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });
}

export async function refreshIntegrations() {
  try {
    const data = await api('/api/integrations/status');
    state.integrations = data.integrations;
    paintMapsBadge();
  } catch {
    paintMapsBadge();
  }
}

export function closeSidebar() {
  dom.sidebar?.classList.remove('is-open');
  if (dom.overlay) dom.overlay.hidden = true;
}

export function parseRoute() {
  const raw = window.location.hash.replace(/^#\/?/, '');
  const [pathPart, queryPart] = raw.split('?');
  const segments = pathPart.split('/').filter(Boolean);
  return {
    name: segments[0] || 'dashboard',
    id: segments[1] || null,
    params: new URLSearchParams(queryPart || ''),
  };
}

export function openModalShell(content, sizeClass = '') {
  dom.modal.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal ${sizeClass}" role="dialog" aria-modal="true">
        ${content}
      </div>
    </div>`;
  document.body.style.overflow = 'hidden';
}

export function closeModal({ updateHash = true } = {}) {
  if (!state.modalLeadId && !dom.modal.innerHTML) return;
  state.modalLeadId = null;
  state.modalLead = null;
  state.modalEditing = false;
  state.modalBusy = false;
  dom.modal.innerHTML = '';
  document.body.style.overflow = '';
  if (updateHash && state.route === 'leads') {
    history.replaceState(null, '', '#/leads');
  }
}

export function selectedExportFields() {
  const fields = state.settings?.exportFields?.filter((field) =>
    EXPORT_FIELDS.some(([key]) => key === field),
  );
  if (fields?.length) return fields;
  return EXPORT_FIELDS.slice(0, 9).map(([key]) => key);
}
