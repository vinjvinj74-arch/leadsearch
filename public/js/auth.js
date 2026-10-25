import {
  DEFAULT_FILTERS,
  ROUTES,
  api,
  applyTheme,
  clearFormMessages,
  closeModal,
  dom,
  errorMessage,
  paintMapsBadge,
  paintUser,
  parseRoute,
  refreshIntegrations,
  setFormBusy,
  showFormError,
  showFormSuccess,
  state,
  toast,
} from './core.js';

const AUTH_TABS = new Set(['login', 'register']);

function clearAuthHash() {
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
}

function setAuthPanel(panel) {
  const panels = document.querySelectorAll('[data-auth-panel]');
  panels.forEach((section) => {
    section.hidden = section.dataset.authPanel !== panel;
  });

  const tabs = document.querySelector('.auth-tabs');
  if (tabs) tabs.hidden = !AUTH_TABS.has(panel);

  document.querySelectorAll('[data-auth-tab]').forEach((button) => {
    const active = button.dataset.authTab === panel;
    button.classList.toggle('is-active', active);
    button.setAttribute('aria-selected', active ? 'true' : 'false');
  });

  const section = document.querySelector(`[data-auth-panel="${panel}"]`);
  const focusable = section?.querySelector('input, button:not(.link-button)');
  if (focusable) window.setTimeout(() => focusable.focus(), 30);
}

export function showAuth({ clearHash = false } = {}) {
  if (state.searchTimer) {
    window.clearInterval(state.searchTimer);
    state.searchTimer = null;
  }
  state.route = 'auth';
  dom.shell.hidden = true;
  dom.auth.hidden = false;
  closeSidebar();
  closeModal({ updateHash: false });
  if (clearHash) clearAuthHash();
  document.title = 'Entrar · LeadSearch';
  setAuthPanel('login');
}

function closeSidebar() {
  dom.sidebar?.classList.remove('is-open');
  if (dom.overlay) dom.overlay.hidden = true;
}

function resetAuthState() {
  if (state.searchTimer) {
    window.clearInterval(state.searchTimer);
    state.searchTimer = null;
  }
  state.user = null;
  state.settings = null;
  state.integrations = null;
  state.csrf = null;
  state.authToken = null;
  state.activeSearch = null;
  state.activeStats = null;
  state.searchHistory = null;
  state.leads.filters = { ...DEFAULT_FILTERS };
  state.leads.page = 1;
  state.leads.data = null;
  state.leads.selected.clear();
  state.leads.loading = false;
  state.leads.seq += 1;
  state.modalLeadId = null;
  state.modalLead = null;
  state.modalEditing = false;
  state.modalBusy = false;
  state.settingsTab = 'profile';
  state.settingsCache = {
    integrations: null,
    diagnostics: null,
    sessions: null,
    mapsTest: null,
    mapsTesting: false,
  };
  dom.main.innerHTML = '';
}

function resetAuthForms() {
  document.querySelectorAll('#login-form, #register-form, #forgot-form, #reset-form').forEach((form) => {
    form.reset();
    setFormBusy(form, false);
  });
}

export function signOutLocal({ message = '' } = {}) {
  resetAuthState();
  resetAuthForms();
  history.replaceState(null, '', `${window.location.pathname}${window.location.search}`);
  showAuth();
  if (message) toast(message, 'info');
}

export async function logout() {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {}
  signOutLocal({ message: 'Sessão encerrada.' });
}

function currentRoute() {
  return parseRoute();
}

export function enterApp(user, settings, integrations = null, { preserveRoute = false } = {}) {
  state.user = user;
  state.settings = settings;
  if (settings?.theme) applyTheme(settings.theme);
  if (integrations) state.integrations = integrations;
  dom.auth.hidden = true;
  dom.shell.hidden = false;
  paintUser();
  paintMapsBadge();
  closeSidebar();
  if (preserveRoute && window.location.hash && ROUTES[currentRoute().name]) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    const target = '#/dashboard';
    if (window.location.hash === target) {
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    } else {
      window.location.hash = target;
    }
  }
  if (!integrations) void refreshIntegrations();
}

function invalidTokenMessage(panel) {
  showAuth();
  if (panel === 'verify') {
    setAuthPanel('verify');
    const message = document.getElementById('verify-message');
    if (message) message.textContent = 'Link de verificação inválido: token ausente.';
  } else {
    toast('Link inválido ou incompleto.', 'error');
  }
}

async function verifyEmailToken(token) {
  showAuth();
  setAuthPanel('verify');
  const message = document.getElementById('verify-message');
  if (message) message.textContent = 'Verificando seu e-mail...';
  try {
    const result = await api('/api/auth/verify-email', { method: 'POST', body: { token } });
    clearAuthHash();
    toast(result.message || 'E-mail verificado com sucesso.', 'success');
    if (state.user) {
      state.user = { ...state.user, emailVerifiedAt: new Date().toISOString() };
      paintUser();
      dom.auth.hidden = true;
      dom.shell.hidden = false;
      window.dispatchEvent(new HashChangeEvent('hashchange'));
      return;
    }
    if (message) message.textContent = result.message || 'E-mail verificado com sucesso.';
  } catch (error) {
    if (message) message.textContent = errorMessage(error);
    toast(errorMessage(error), 'error');
    clearAuthHash();
  }
}

export function initAuthRoute() {
  const route = currentRoute();
  if (route.name === 'reset-password') {
    const token = route.params.get('token');
    if (!token) {
      invalidTokenMessage('reset');
      return true;
    }
    showAuth();
    state.authToken = token;
    setAuthPanel('reset');
    return true;
  }
  if (route.name === 'verify-email') {
    const token = route.params.get('token');
    if (!token) {
      invalidTokenMessage('verify');
      return true;
    }
    void verifyEmailToken(token);
    return true;
  }
  return false;
}

export function handleAuthAction(element) {
  if (element.dataset.authTab) {
    const panel = element.dataset.authTab;
    if (!AUTH_TABS.has(panel)) return true;
    setAuthPanel(panel);
    if (window.location.hash.includes('reset-password') || window.location.hash.includes('verify-email')) {
      clearAuthHash();
    }
    return true;
  }
  if (element.dataset.authLink) {
    const panel = element.dataset.authLink;
    if (panel === 'login' || panel === 'forgot') {
      setAuthPanel(panel);
      clearAuthHash();
      state.authToken = null;
    }
    return true;
  }
  return false;
}

export async function handleAuthSubmit(form) {
  clearFormMessages(form);

  if (form.id === 'login-form') {
    const data = Object.fromEntries(new FormData(form).entries());
    setFormBusy(form, true, 'Entrando...');
    try {
      const result = await api('/api/auth/login', {
        method: 'POST',
        body: { email: data.email, password: data.password },
      });
      setFormBusy(form, false);
      form.reset();
      enterApp(result.user, result.settings);
      toast(`Bem-vindo, ${result.user.name}.`, 'success');
    } catch (error) {
      showFormError(form, errorMessage(error));
      setFormBusy(form, false);
    }
    return;
  }

  if (form.id === 'register-form') {
    const data = Object.fromEntries(new FormData(form).entries());
    if (String(data.password ?? '') !== String(data.confirmPassword ?? '')) {
      showFormError(form, 'A confirmação não corresponde à senha.');
      return;
    }
    setFormBusy(form, true, 'Criando conta...');
    try {
      const result = await api('/api/auth/register', {
        method: 'POST',
        body: { name: data.name, email: data.email, password: data.password },
      });
      setFormBusy(form, false);
      form.reset();
      enterApp(result.user, result.settings);
      toast(
        result.emailVerificationSent
          ? 'Conta criada. Enviamos um link para verificar seu e-mail.'
          : 'Conta criada. Configure o SMTP no servidor para habilitar a verificação de e-mail.',
        'success',
        7000,
      );
    } catch (error) {
      showFormError(form, errorMessage(error));
      setFormBusy(form, false);
    }
    return;
  }

  if (form.id === 'forgot-form') {
    const data = Object.fromEntries(new FormData(form).entries());
    setFormBusy(form, true, 'Enviando...');
    try {
      const result = await api('/api/auth/forgot-password', {
        method: 'POST',
        body: { email: data.email },
      });
      showFormSuccess(form, result.message || 'Se o e-mail estiver cadastrado, enviaremos as instruções.');
    } catch (error) {
      showFormError(form, errorMessage(error));
    } finally {
      setFormBusy(form, false);
    }
    return;
  }

  if (form.id === 'reset-form') {
    if (!state.authToken) {
      showFormError(form, 'Link inválido ou expirado. Solicite uma nova redefinição.');
      return;
    }
    const data = Object.fromEntries(new FormData(form).entries());
    if (String(data.password ?? '') !== String(data.confirmPassword ?? '')) {
      showFormError(form, 'A confirmação não corresponde à nova senha.');
      return;
    }
    setFormBusy(form, true, 'Redefinindo...');
    try {
      const result = await api('/api/auth/reset-password', {
        method: 'POST',
        body: { token: state.authToken, password: data.password },
      });
      form.reset();
      setFormBusy(form, false);
      signOutLocal();
      toast(result.message || 'Senha redefinida. Entre com a nova senha.', 'success', 7000);
    } catch (error) {
      showFormError(form, errorMessage(error));
      setFormBusy(form, false);
    }
  }
}
