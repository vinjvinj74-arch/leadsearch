import {
  DEFAULT_WEIGHTS,
  EXPORT_FIELDS,
  WEIGHT_FIELDS,
  api,
  applyTheme,
  clearFormMessages,
  dom,
  emailConfigured,
  emptyState,
  errorMessage,
  esc,
  option,
  pageSkeleton,
  paintMapsBadge,
  paintUser,
  selectedExportFields,
  setFormBusy,
  showFormError,
  state,
  toast,
} from './core.js';
import {
  handleAdvancedSettingsAction,
  handleAdvancedSettingsSubmit,
  integrationsTabMarkup,
  loadIntegrationsTabData,
  loadSecurityTabData,
  securityTabMarkup,
} from './settingsAdvanced.js';

const MAX_SEARCH_RESULTS = 5;

const TABS = [
  ['profile', 'Perfil'],
  ['preferences', 'Preferências'],
  ['score', 'Pontuação'],
  ['export', 'Exportação'],
  ['integrations', 'Integrações'],
  ['security', 'Segurança'],
];

const checked = (value) => (value ? ' checked' : '');

function profileTabMarkup() {
  const user = state.user;
  const verifyBadge = user.emailVerifiedAt
    ? '<span class="badge badge-success">E-mail verificado</span>'
    : '<span class="badge badge-warning">E-mail pendente</span>';
  const canSend = emailConfigured() !== false;
  return `
    <div class="settings-panel">
      <section class="settings-section">
        <h3>Perfil</h3>
        <p>Seus dados de acesso. O e-mail é usado para login e recuperação de senha.</p>
        <form class="form-stack" data-form="settings-profile" novalidate>
          <div class="form-grid">
            <label class="field">
              <span>Nome</span>
              <input type="text" name="name" required minlength="2" maxlength="80" value="${esc(user.name)}" autocomplete="name" />
            </label>
            <label class="field">
              <span>E-mail ${verifyBadge}</span>
              <input type="email" name="email" required maxlength="254" value="${esc(user.email)}" autocomplete="email" />
            </label>
          </div>
          <p class="small muted">Ao alterar o e-mail, a verificação volta para pendente.</p>
          <p class="form-error" data-form-error role="alert" hidden></p>
          <div class="settings-actions"><button class="btn btn-primary" type="submit">Salvar perfil</button></div>
        </form>
      </section>

      <section class="settings-section">
        <h3>Verificação de e-mail</h3>
        <p>${
          user.emailVerifiedAt
            ? `Verificado em ${esc(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long', timeStyle: 'short' }).format(new Date(user.emailVerifiedAt)))}.`
            : 'Confirme seu e-mail para proteger a recuperação da conta.'
        }</p>
        ${
          user.emailVerifiedAt
            ? ''
            : `<button class="btn" type="button" data-action="settings-resend-verification" ${canSend ? '' : 'disabled title="SMTP não configurado no servidor"'}>Reenviar verificação</button>
               ${canSend ? '' : '<p class="small muted" style="margin-top:8px">O envio exige SMTP configurado no servidor.</p>'}`
        }
      </section>

      <section class="settings-section">
        <h3>Conta</h3>
        <p>Identificador e data de criação.</p>
        <dl class="kv small">
          <dt>ID da conta</dt><dd class="mono">${esc(user.id)}</dd>
          <dt>Criada em</dt><dd>${esc(new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' }).format(new Date(user.createdAt)))}</dd>
        </dl>
      </section>
    </div>`;
}

function preferencesTabMarkup() {
  const settings = state.settings;
  const favorites = settings.favoriteNiches ?? [];
  return `
    <div class="settings-panel">
      <section class="settings-section">
        <h3>Preferências de prospecção</h3>
        <p>Valores usados para preencher o formulário de nova pesquisa.</p>
        <form class="form-stack" data-form="settings-preferences" novalidate>
          <div class="form-grid">
            <label class="field">
              <span>Nicho padrão</span>
              <input type="text" name="defaultNiche" maxlength="100" value="${esc(settings.defaultNiche ?? '')}" placeholder="Ex.: clínica odontológica" />
            </label>
            <label class="field">
              <span>Cidade padrão</span>
              <input type="text" name="defaultCity" maxlength="100" value="${esc(settings.defaultCity ?? '')}" placeholder="Ex.: Campinas" />
            </label>
            <label class="field">
              <span>UF / Estado padrão</span>
              <input type="text" name="defaultState" maxlength="100" value="${esc(settings.defaultState ?? '')}" placeholder="Ex.: SP" />
            </label>
            <label class="field">
              <span>País padrão</span>
              <input type="text" name="defaultCountry" required maxlength="100" value="${esc(settings.defaultCountry ?? 'Brasil')}" />
            </label>
            <label class="field">
              <span>Limite padrão de resultados</span>
              <input type="number" name="defaultLimit" min="1" max="5" step="1" value="${esc(settings.defaultLimit ?? MAX_SEARCH_RESULTS)}" />
              <small class="hint">Entre 1 e 5 empresas por pesquisa.</small>
            </label>
            <label class="field">
              <span>Retenção de dados (dias)</span>
              <input type="number" name="retentionDays" min="30" max="3650" step="1" value="${esc(settings.retentionDays ?? 365)}" />
              <small class="hint">Entre 30 e 3650 dias.</small>
            </label>
            <label class="field field-full">
              <span>Nichos favoritos</span>
              <input type="text" name="favoriteNiches" maxlength="1800" value="${esc(favorites.join(', '))}" placeholder="Ex.: clínica odontológica, academia, pet shop" />
              <small class="hint">Separe por vírgula. Até 20 nichos aparecem como atalhos na prospecção.</small>
            </label>
            <label class="field">
              <span>Tema da interface</span>
              <select name="theme">
                ${option('system', 'Seguir o sistema', settings.theme)}
                ${option('dark', 'Escuro', settings.theme)}
                ${option('light', 'Claro', settings.theme)}
              </select>
            </label>
          </div>
          <label class="checkbox-row">
            <input type="checkbox" name="allowEnrichment"${checked(settings.allowEnrichment)} />
            <span>Enriquecer contatos automaticamente após cada pesquisa</span>
          </label>
          <p class="small muted">Desativar o enriquecimento deixa a pesquisa mais rápida, mas não coleta e-mails e telefones publicados no site.</p>
          <p class="form-error" data-form-error role="alert" hidden></p>
          <div class="settings-actions"><button class="btn btn-primary" type="submit">Salvar preferências</button></div>
        </form>
      </section>
    </div>`;
}

function scoreTabMarkup() {
  const settings = state.settings;
  const weights = { ...DEFAULT_WEIGHTS, ...(settings.scoreWeights ?? {}) };
  return `
    <div class="settings-panel">
      <section class="settings-section">
        <h3>Pesos da pontuação</h3>
        <p>Cada critério soma pontos ao score do lead. Ajuste os pesos para refletir seu modelo comercial.</p>
        <form class="form-stack" data-form="settings-score" novalidate>
          <div class="weights-grid">
            ${WEIGHT_FIELDS.map(
              ([key, label, max]) => `
              <label class="field">
                <span>${esc(label)}</span>
                <input type="number" name="${esc(key)}" min="0" max="${max}" step="1" value="${esc(weights[key] ?? 0)}" />
                <small class="hint">Máx. ${max}</small>
              </label>`,
            ).join('')}
          </div>
          <div class="notice notice-info">
            <span>O score final é limitado a 100. O valor automático aparece em cada lead; um score manual pode substituí-lo sem apagar o cálculo.</span>
          </div>
          <p class="form-error" data-form-error role="alert" hidden></p>
          <div class="settings-actions">
            <button class="btn btn-ghost" type="button" data-action="settings-reset-weights">Restaurar padrões</button>
            <button class="btn btn-primary" type="submit">Salvar pesos</button>
          </div>
        </form>
      </section>
    </div>`;
}

function exportTabMarkup() {
  const selected = new Set(selectedExportFields());
  return `
    <div class="settings-panel">
      <section class="settings-section">
        <h3>Campos da exportação CSV</h3>
        <p>Escolha as colunas usadas por padrão ao exportar leads.</p>
        <form class="form-stack" data-form="settings-export" novalidate>
          <div class="form-grid">
            ${EXPORT_FIELDS.map(
              ([key, label]) => `
              <label class="checkbox-row">
                <input type="checkbox" name="fields" value="${esc(key)}"${checked(selected.has(key))} />
                <span>${esc(label)}</span>
              </label>`,
            ).join('')}
          </div>
          <p class="form-error" data-form-error role="alert" hidden></p>
          <div class="settings-actions"><button class="btn btn-primary" type="submit">Salvar campos</button></div>
        </form>
      </section>
      <section class="settings-section">
        <h3>Exportação completa</h3>
        <p>Para baixar todos os dados da conta em JSON, acesse a aba Segurança.</p>
        <a class="btn" href="/api/account/export">Baixar backup da conta</a>
      </section>
    </div>`;
}

function tabMarkup(tab) {
  if (tab === 'preferences') return preferencesTabMarkup();
  if (tab === 'score') return scoreTabMarkup();
  if (tab === 'export') return exportTabMarkup();
  if (tab === 'security') return securityTabMarkup();
  if (tab === 'integrations') return integrationsTabMarkup();
  return profileTabMarkup();
}

function settingsLayoutMarkup() {
  return `
    <div class="settings-layout">
      <nav class="settings-nav" aria-label="Seções de configuração">
        ${TABS.map(
          ([key, label]) =>
            `<button type="button" data-settings-tab="${key}" data-action="settings-tab" class="${state.settingsTab === key ? 'is-active' : ''}">${label}</button>`,
        ).join('')}
      </nav>
      <div id="settings-tab-content"></div>
    </div>`;
}

export function renderSettingsTab() {
  const container = document.getElementById('settings-tab-content');
  if (!container) return;
  document.querySelectorAll('[data-settings-tab]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.settingsTab === state.settingsTab);
    if (button.dataset.settingsTab === state.settingsTab) button.setAttribute('aria-current', 'true');
    else button.removeAttribute('aria-current');
  });
  container.innerHTML = tabMarkup(state.settingsTab);
}

function currentRerender(tab) {
  return () => {
    if (state.route === 'settings' && state.settingsTab === tab) renderSettingsTab();
  };
}

function loadTabData() {
  if (state.settingsTab === 'security') {
    if (state.settingsCache.sessions === null) {
      void loadSecurityTabData(currentRerender('security'));
    }
  } else if (state.settingsTab === 'integrations') {
    if (state.settingsCache.diagnostics === null) {
      void loadIntegrationsTabData(currentRerender('integrations'));
    }
  }
}

export async function renderSettings() {
  dom.main.innerHTML = pageSkeleton('settings');
  try {
    const data = await api('/api/settings');
    if (state.route !== 'settings') return;
    state.settings = data.settings;
    paintMapsBadge();
    dom.main.innerHTML = settingsLayoutMarkup();
    renderSettingsTab();
    loadTabData();
  } catch (error) {
    if (state.route !== 'settings') return;
    dom.main.innerHTML = `
      <section class="panel">
        <div class="panel-body">
          ${emptyState('Não foi possível carregar as configurações', errorMessage(error), '<button class="btn" type="button" data-action="retry-route">Tentar novamente</button>')}
        </div>
      </section>`;
  }
}

function parseFavorites(value) {
  const seen = new Set();
  const niches = [];
  String(value ?? '')
    .split(/[,;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .forEach((entry) => {
      const key = entry.toLowerCase();
      if (!seen.has(key) && niches.length < 20) {
        seen.add(key);
        niches.push(entry.slice(0, 80));
      }
    });
  return niches;
}

async function savePreferences(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  const limit = Number(data.defaultLimit);
  const retention = Number(data.retentionDays);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_RESULTS) {
    showFormError(form, `O limite padrão deve ser um número inteiro entre 1 e ${MAX_SEARCH_RESULTS}.`);
    return;
  }
  if (!Number.isInteger(retention) || retention < 30 || retention > 3650) {
    showFormError(form, 'A retenção deve ser um número inteiro entre 30 e 3650 dias.');
    return;
  }
  setFormBusy(form, true, 'Salvando...');
  try {
    const result = await api('/api/settings', {
      method: 'PATCH',
      body: {
        theme: data.theme,
        defaultCity: data.defaultCity || null,
        defaultState: data.defaultState || null,
        defaultCountry: data.defaultCountry || 'Brasil',
        defaultNiche: data.defaultNiche || null,
        defaultLimit: limit,
        favoriteNiches: parseFavorites(data.favoriteNiches),
        allowEnrichment: form.querySelector('[name="allowEnrichment"]')?.checked ?? false,
        retentionDays: retention,
      },
    });
    state.settings = result.settings;
    applyTheme(result.settings.theme);
    toast('Preferências salvas.', 'success');
    renderSettingsTab();
  } catch (error) {
    showFormError(form, errorMessage(error));
    setFormBusy(form, false);
  }
}

async function saveScore(form) {
  const weights = {};
  for (const [key, , max] of WEIGHT_FIELDS) {
    const input = form.querySelector(`[name="${key}"]`);
    const value = Number(input?.value ?? 0);
    if (!Number.isInteger(value) || value < 0 || value > Number(max)) {
      showFormError(form, `O peso "${key}" deve ser um inteiro entre 0 e ${max}.`);
      return;
    }
    weights[key] = value;
  }
  setFormBusy(form, true, 'Salvando...');
  try {
    const result = await api('/api/settings', { method: 'PATCH', body: { scoreWeights: weights } });
    state.settings = result.settings;
    toast('Pesos da pontuação atualizados.', 'success');
    renderSettingsTab();
  } catch (error) {
    showFormError(form, errorMessage(error));
    setFormBusy(form, false);
  }
}

async function saveExportFields(form) {
  const fields = [...form.querySelectorAll('input[name="fields"]:checked')].map((input) => input.value);
  if (!fields.length) {
    showFormError(form, 'Selecione pelo menos um campo para exportação.');
    return;
  }
  setFormBusy(form, true, 'Salvando...');
  try {
    const result = await api('/api/settings', { method: 'PATCH', body: { exportFields: fields } });
    state.settings = result.settings;
    toast('Campos de exportação salvos.', 'success');
    renderSettingsTab();
  } catch (error) {
    showFormError(form, errorMessage(error));
    setFormBusy(form, false);
  }
}

async function saveProfile(form) {
  const data = Object.fromEntries(new FormData(form).entries());
  if (!String(data.name ?? '').trim() || String(data.name).trim().length < 2) {
    showFormError(form, 'Informe seu nome.');
    return;
  }
  setFormBusy(form, true, 'Salvando...');
  try {
    const result = await api('/api/account', {
      method: 'PATCH',
      body: { name: String(data.name).trim(), email: String(data.email ?? '').trim() },
    });
    state.user = result.user;
    paintUser();
    if (result.emailVerificationSent) {
      toast('Perfil atualizado. Enviamos a verificação para o novo e-mail.', 'success', 7000);
    } else {
      toast('Perfil atualizado.', 'success');
    }
    renderSettingsTab();
  } catch (error) {
    showFormError(form, errorMessage(error));
    setFormBusy(form, false);
  }
}

export async function handleSettingsAction(element) {
  const action = element.dataset.action;

  if (action === 'settings-tab') {
    const tab = element.dataset.settingsTab;
    if (!TABS.some(([key]) => key === tab)) return true;
    state.settingsTab = tab;
    if (tab === 'security') state.settingsCache.sessions = null;
    if (tab === 'integrations') state.settingsCache.diagnostics = null;
    renderSettingsTab();
    loadTabData();
    return true;
  }

  if (action === 'settings-reset-weights') {
    const form = element.closest('form');
    if (form) {
      WEIGHT_FIELDS.forEach(([key]) => {
        const input = form.querySelector(`[name="${key}"]`);
        if (input) input.value = DEFAULT_WEIGHTS[key];
      });
      toast('Pesos padrão carregados. Salve para aplicar.', 'info');
    }
    return true;
  }

  return handleAdvancedSettingsAction(element, currentRerender(state.settingsTab));
}

export async function handleSettingsSubmit(form) {
  clearFormMessages(form);
  if (await handleAdvancedSettingsSubmit(form)) return;

  const kind = form.dataset.form;
  if (kind === 'settings-profile') {
    await saveProfile(form);
    return;
  }
  if (kind === 'settings-preferences') {
    await savePreferences(form);
    return;
  }
  if (kind === 'settings-score') {
    await saveScore(form);
    return;
  }
  if (kind === 'settings-export') {
    await saveExportFields(form);
  }
}
