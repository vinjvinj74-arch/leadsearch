import {
  BRAND,
  LEGACY_THEME_KEY,
  ROUTES,
  THEME_KEY,
  api,
  applyTheme,
  closeModal,
  closeSidebar,
  dom,
  errorMessage,
  parseRoute,
  state,
  toast,
} from './js/core.js';
import {
  enterApp,
  handleAuthAction,
  handleAuthSubmit,
  initAuthRoute,
  logout,
  showAuth,
  signOutLocal,
} from './js/auth.js';
import { renderDashboard } from './js/dashboard.js';
import { handleSearchAction, handleSearchSubmit, renderSearch, stopSearchPolling } from './js/search.js';
import {
  handleLeadsAction,
  handleLeadsChange,
  handleLeadsSubmit,
  refreshLeadsSilently,
  renderLeadsRoute,
} from './js/leads.js';
import { handleLeadModalClick, handleLeadModalSubmit, openLead } from './js/leadDetail.js';
import {
  destroyRadar,
  handleRadarAction,
  handleRadarChange,
  handleRadarInput,
  handleRadarSubmit,
  refreshRadarAfterLeadChange,
  renderRadar,
} from './js/radar.js';
import {
  handleSettingsAction,
  handleSettingsSubmit,
  renderSettings,
  renderSettingsTab,
} from './js/settings.js';

const AUTH_FORM_IDS = new Set(['login-form', 'register-form', 'forgot-form', 'reset-form']);
let routeToken = 0;

function toggleTheme() {
  const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
  applyTheme(next);
  if (state.user) {
    void api('/api/settings', { method: 'PATCH', body: { theme: next } })
      .then((result) => {
        if (result?.settings) state.settings = result.settings;
      })
      .catch(() => {});
  }
}

function openSidebar() {
  dom.sidebar?.classList.add('is-open');
  if (dom.overlay) dom.overlay.hidden = false;
}

function toggleSidebar() {
  if (dom.sidebar?.classList.contains('is-open')) closeSidebar();
  else openSidebar();
}

async function renderRoute() {
  if (!state.user) {
    if (!initAuthRoute()) showAuth();
    return;
  }

  const parsed = parseRoute();
  if (parsed.name === 'reset-password' || parsed.name === 'verify-email') {
    initAuthRoute();
    return;
  }
  let name = parsed.name;
  if (!Object.prototype.hasOwnProperty.call(ROUTES, name)) {
    name = 'dashboard';
    history.replaceState(null, '', '#/dashboard');
  }

  state.route = name;
  stopSearchPolling();
  destroyRadar();
  closeModal({ updateHash: false });
  closeSidebar();
  const token = ++routeToken;

  dom.pageTitle.textContent = ROUTES[name].title;
  dom.pageSubtitle.textContent = ROUTES[name].subtitle;
  document.title = `${ROUTES[name].title} · ${BRAND}`;
  document.querySelectorAll('.nav-link[data-route]').forEach((link) => {
    const active = link.dataset.route === name;
    link.classList.toggle('is-active', active);
    if (active) link.setAttribute('aria-current', 'page');
    else link.removeAttribute('aria-current');
  });

  if (name === 'dashboard') {
    await renderDashboard();
    return;
  }
  if (name === 'search') {
    await renderSearch();
    return;
  }
  if (name === 'leads') {
    await renderLeadsRoute();
    if (token === routeToken && state.route === 'leads' && parsed.id && parseRoute().id === parsed.id) {
      await openLead(parsed.id, false);
    }
    return;
  }
  if (name === 'settings') {
    await renderSettings();
    return;
  }
  if (name === 'radar') {
    await renderRadar(parsed.id);
  }
}

function isInteractive(target) {
  return Boolean(target.closest('a, button, input, select, textarea, label'));
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;

  if (target.closest('.skip-link')) {
    event.preventDefault();
    dom.main.focus();
    dom.main.scrollIntoView({ block: 'start' });
    return;
  }

  if (target.closest('.theme-toggle')) {
    toggleTheme();
    return;
  }

  if (target.closest('#logout-button')) {
    event.preventDefault();
    void logout();
    return;
  }

  if (target.closest('#menu-toggle')) {
    toggleSidebar();
    return;
  }

  if (target.closest('#mobile-overlay')) {
    closeSidebar();
    return;
  }

  if (target.matches('[data-modal-backdrop]') || target.closest('[data-action="close-modal"]')) {
    closeModal();
    return;
  }

  if (target.closest('[data-action="close-upgrade"]')) {
    const modal = document.getElementById('upgrade-modal');
    if (modal) modal.remove();
    document.body.style.overflow = '';
    return;
  }

  const authAction = target.closest('[data-auth-tab], [data-auth-link]');
  if (authAction) {
    if (handleAuthAction(authAction)) {
      event.preventDefault();
      return;
    }
  }

  const actionElement = target.closest('[data-action]');
  if (actionElement) {
    const action = actionElement.dataset.action;
    if (action === 'open-lead') {
      event.preventDefault();
      void openLead(actionElement.dataset.id, false);
      return;
    }
    if (action === 'retry-route') {
      event.preventDefault();
      void renderRoute();
      return;
    }
    if (action?.startsWith('search-')) {
      handleSearchAction(actionElement);
      return;
    }
    if (action?.startsWith('leads-')) {
      handleLeadsAction(actionElement);
      return;
    }
    if (action?.startsWith('settings-')) {
      void handleSettingsAction(actionElement);
      return;
    }
    if (action?.startsWith('radar-')) {
      void handleRadarAction(actionElement);
      return;
    }
    if (
      action?.startsWith('lead-') ||
      action === 'edit-lead' ||
      action === 'cancel-edit' ||
      action === 'copy-value'
    ) {
      handleLeadModalClick(actionElement);
      return;
    }
  }

  const row = target.closest('tr[data-lead-id]');
  if (row && !isInteractive(target)) {
    void openLead(row.dataset.leadId, true);
  }
});

document.addEventListener('submit', (event) => {
  const form = event.target;
  if (!(form instanceof HTMLFormElement)) return;

  if (AUTH_FORM_IDS.has(form.id)) {
    event.preventDefault();
    void handleAuthSubmit(form);
    return;
  }

  const kind = form.dataset.form;
  if (!kind) return;
  event.preventDefault();

  if (kind === 'search') {
    void handleSearchSubmit(form);
    return;
  }
  if (kind === 'leads-filters') {
    void handleLeadsSubmit(form);
    return;
  }
  if (kind.startsWith('settings-') || kind === 'delete-account') {
    void handleSettingsSubmit(form);
    return;
  }
  if (kind === 'lead-edit' || kind === 'activity') {
    void handleLeadModalSubmit(form);
  }
  if (kind === 'radar') {
    void handleRadarSubmit(form);
  }
});

document.addEventListener('change', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (state.route === 'leads') handleLeadsChange(target);
  if (state.route === 'radar') handleRadarChange(target);
});

document.addEventListener('input', (event) => {
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (state.route === 'radar') handleRadarInput(target);
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (dom.modal.innerHTML) {
      closeModal();
      return;
    }
    if (dom.sidebar?.classList.contains('is-open')) closeSidebar();
    return;
  }
  if (event.key === 'Enter') {
    const target = event.target;
    if (!(target instanceof Element) || isInteractive(target)) return;
    const row = target.closest('tr[data-lead-id]');
    if (row) {
      event.preventDefault();
      void openLead(row.dataset.leadId, true);
    }
  }
});

window.addEventListener('hashchange', () => {
  void renderRoute();
});

window.addEventListener('auth:expired', () => {
  if (!state.user) return;
  signOutLocal({ message: 'Sua sessão expirou. Entre novamente.' });
});

window.addEventListener('auth:deleted', () => {
  signOutLocal({ message: 'Conta e dados associados foram excluídos.' });
});

window.addEventListener('leads:changed', () => {
  if (state.route === 'leads') void refreshLeadsSilently();
  else if (state.route === 'dashboard') void renderDashboard();
  else if (state.route === 'radar') void refreshRadarAfterLeadChange();
});

window.addEventListener('settings:rerender', () => {
  if (state.route === 'settings') renderSettingsTab();
});

async function boot() {
  const legacyTheme = localStorage.getItem(LEGACY_THEME_KEY);
  const storedTheme = localStorage.getItem(THEME_KEY) || legacyTheme || 'system';
  applyTheme(storedTheme);

  const media = window.matchMedia('(prefers-color-scheme: light)');
  media.addEventListener('change', () => {
    if (state.themePreference === 'system') applyTheme('system');
  });

  if (initAuthRoute()) return;

  try {
    const data = await api('/api/auth/me');
    enterApp(data.user, data.settings, data.integrations, { preserveRoute: true });
  } catch (error) {
    showAuth();
    if (error?.status !== 401) toast(errorMessage(error), 'error');
  }
}

void boot();
