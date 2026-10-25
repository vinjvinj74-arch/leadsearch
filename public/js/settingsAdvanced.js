import {
  api,
  clearFormMessages,
  closeModal,
  emailConfigured,
  errorMessage,
  esc,
  fmtDate,
  fmtNumber,
  mapsConfigured,
  openModalShell,
  paintMapsBadge,
  refreshIntegrations,
  setFormBusy,
  showFormError,
  state,
  toast,
} from './core.js';

function sessionsMarkup() {
  const sessions = state.settingsCache.sessions;
  if (sessions === null) {
    return `
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line"></div>`;
  }
  if (!sessions.length) return '<p class="small muted">Nenhuma sessão ativa encontrada.</p>';
  return `<div class="session-list">${sessions
    .map(
      (session) => `
      <div class="session-item">
        <div>
          <strong>${session.current ? 'Este dispositivo' : 'Outro dispositivo'}</strong>
          <small>${esc(session.userAgent || 'Navegador não identificado')}</small>
          <small>Iniciada em ${esc(fmtDate(session.createdAt, true))} · último acesso ${esc(fmtDate(session.lastSeenAt, true))}</small>
        </div>
        <div class="row">
          ${session.current ? '<span class="badge badge-success">Atual</span>' : ''}
          <button class="btn btn-sm ${session.current ? 'btn-danger-ghost' : ''}" type="button" data-action="settings-revoke-session" data-id="${esc(session.id)}" data-current="${session.current ? 'true' : 'false'}">Encerrar</button>
        </div>
      </div>`,
    )
    .join('')}</div>`;
}

export function securityTabMarkup() {
  return `
    <div class="settings-panel">
      <section class="settings-section">
        <h3>Alterar senha</h3>
        <p>Use pelo menos 10 caracteres, com letras e números. As demais sessões serão encerradas.</p>
        <form class="form-stack" data-form="settings-password" novalidate>
          <div class="form-grid">
            <label class="field field-full">
              <span>Senha atual</span>
              <input type="password" name="currentPassword" required maxlength="128" autocomplete="current-password" />
            </label>
            <label class="field">
              <span>Nova senha</span>
              <input type="password" name="newPassword" required minlength="10" maxlength="128" autocomplete="new-password" />
            </label>
            <label class="field">
              <span>Confirmar nova senha</span>
              <input type="password" name="confirmPassword" required maxlength="128" autocomplete="new-password" />
            </label>
          </div>
          <p class="form-error" data-form-error role="alert" hidden></p>
          <div class="settings-actions"><button class="btn btn-primary" type="submit">Alterar senha</button></div>
        </form>
      </section>

      <section class="settings-section">
        <div class="row-between" style="margin-bottom:12px">
          <div>
            <h3>Sessões ativas</h3>
            <p style="margin:2px 0 0">Dispositivos com acesso à sua conta.</p>
          </div>
          <button class="btn btn-ghost btn-sm" type="button" data-action="settings-logout-all">Encerrar todas</button>
        </div>
        ${sessionsMarkup()}
      </section>

      <section class="settings-section">
        <h3>Seus dados</h3>
        <p>Baixe um arquivo JSON com conta, configurações, leads, atividades, pesquisas, contatos e origens.</p>
        <a class="btn" href="/api/account/export">Baixar dados (JSON)</a>
      </section>

      <section class="settings-section danger-zone">
        <h3>Excluir conta</h3>
        <p>A exclusão remove permanentemente sua conta e todos os dados associados. Esta ação não pode ser desfeita.</p>
        <button class="btn btn-danger" type="button" data-action="settings-delete-account">Excluir minha conta</button>
      </section>
    </div>`;
}

function integrationCard({ title, configured, label, note, action = '' }) {
  const badge = configured
    ? '<span class="badge badge-success">Configurado</span>'
    : '<span class="badge badge-warning">Pendente</span>';
  return `
    <div class="integration-card">
      <div>
        <h4>${esc(title)} ${badge}</h4>
        <p>${esc(label || '')}${note ? `<br>${esc(note)}` : ''}</p>
      </div>
      ${action ? `<div class="row">${action}</div>` : ''}
    </div>`;
}

function mapsTestMarkup() {
  const result = state.settingsCache.mapsTest;
  if (!result) return '';
  if (result.ok === false) {
    return `<div class="notice notice-danger" style="margin-top:12px"><span><strong>Teste falhou.</strong> ${esc(result.message)}</span></div>`;
  }
  return `<div class="notice notice-success" style="margin-top:12px"><span><strong>Conectividade confirmada.</strong> O serviço respondeu em ${fmtNumber(result.latencyMs)} ms. Nenhuma pesquisa foi iniciada.</span></div>`;
}

function diagnosticsMarkup() {
  const diagnostics = state.settingsCache.diagnostics;
  if (diagnostics === null) {
    return `
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line" style="width:65%"></div>`;
  }
  if (diagnostics.error) {
    return `<div class="notice notice-danger"><span>${esc(diagnostics.error)}</span></div>`;
  }
  const db = diagnostics.database ?? {};
  const app = diagnostics.app ?? {};
  const counts = diagnostics.counts ?? {};
  const limits = diagnostics.limits ?? {};
  const uptime = Number(app.uptimeSeconds ?? 0);
  const uptimeText =
    uptime >= 86400
      ? `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h`
      : uptime >= 3600
        ? `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}min`
        : `${Math.floor(uptime / 60)}min`;
  return `
    <dl class="kv small">
      <dt>Aplicação</dt><dd>${esc(app.name ?? 'LeadSearch')} ${esc(app.version ?? '')} · ${esc(app.environment ?? '—')}</dd>
      <dt>Node.js</dt><dd>${esc(app.node ?? '—')} · ativa há ${esc(uptimeText)}</dd>
      <dt>Banco de dados</dt><dd>${db.ok ? `<span class="badge badge-success">Online</span> ${fmtNumber(db.latencyMs)} ms` : `<span class="badge badge-danger">Indisponível</span>${db.error ? ` · ${esc(db.error)}` : ''}`}</dd>
      <dt>Migração</dt><dd>${esc(db.migrationVersion ?? '—')}${db.migrationAppliedAt ? ` · ${esc(fmtDate(db.migrationAppliedAt, true))}` : ''}</dd>
      <dt>Registros</dt><dd>${fmtNumber(counts.leads)} leads · ${fmtNumber(counts.searches)} pesquisas · ${fmtNumber(counts.activities)} atividades</dd>
      <dt>Limites</dt><dd>Até ${fmtNumber(limits.maxSearchResults)} resultados por pesquisa · ${fmtNumber(limits.exportMaxRows)} linhas por exportação</dd>
      <dt>Verificado em</dt><dd>${esc(fmtDate(diagnostics.timestamp, true))}</dd>
    </dl>`;
}

export function integrationsTabMarkup() {
  const maps = mapsConfigured();
  const mail = emailConfigured();
  const integrations = state.integrations ?? {};
  const mapsInfo = integrations.discovery ?? {};
  const emailInfo = integrations.email ?? {};
  const database = integrations.database ?? {};
  const testing = Boolean(state.settingsCache.mapsTesting);
  const diagnostics = state.settingsCache.diagnostics;
  const tested = diagnostics && !diagnostics.error && diagnostics.integrations;
  const mapsNote = mapsInfo.note || (tested ? diagnostics.integrations.discovery?.note : '');
  const emailNote = emailInfo.note || (tested ? diagnostics.integrations.email.note : '');

  return `
    <div class="settings-panel">
      <section class="settings-section">
        <h3>Integrações</h3>
        <p>As chaves ficam apenas no servidor. Nenhum segredo é enviado ao navegador.</p>
        <div class="stack" style="gap:10px">
          ${integrationCard({
            title: 'Pesquisa de empresas',
            configured: maps === true,
            label: mapsInfo.label || (maps ? 'Configurada no servidor' : 'Não configurada no servidor'),
            note: mapsNote || 'Pesquisa de empresas habilitada para todos os usuários.',
            action: `<button class="btn btn-sm" type="button" data-action="settings-test-maps" ${maps === false || testing ? 'disabled' : ''}>${testing ? 'Testando...' : 'Testar conexão'}</button>`,
          })}
          ${integrationCard({
            title: 'SMTP / E-mail',
            configured: mail === true,
            label: emailInfo.label || (mail ? 'Configurado no servidor' : 'Não configurado no servidor'),
            note: emailNote || 'Habilita recuperação de senha e verificação de e-mail.',
          })}
          ${integrationCard({
            title: 'PostgreSQL',
            configured: database.configured === true,
            label: database.label || 'Banco de dados da aplicação',
            note: 'Armazena leads, histórico e configurações com isolamento por usuário.',
          })}
        </div>
        ${mapsTestMarkup()}
        <p class="small muted" style="margin-top:10px">O teste valida a conectividade da pesquisa de empresas sem iniciar nenhuma pesquisa.</p>
      </section>

      <section class="settings-section">
        <div class="row-between" style="margin-bottom:12px">
          <div>
            <h3>Diagnóstico do sistema</h3>
            <p style="margin:2px 0 0">Estado do servidor, banco e limites.</p>
          </div>
          <button class="btn btn-sm" type="button" data-action="settings-refresh-diagnostics">Atualizar</button>
        </div>
        ${diagnosticsMarkup()}
      </section>
    </div>`;
}

export async function loadSecurityTabData(rerender) {
  state.settingsCache.sessions = null;
  rerender();
  try {
    const data = await api('/api/account/sessions');
    state.settingsCache.sessions = data.sessions;
  } catch (error) {
    state.settingsCache.sessions = [];
    toast(errorMessage(error), 'error');
  }
  rerender();
}

export async function loadIntegrationsTabData(rerender) {
  state.settingsCache.diagnostics = null;
  rerender();
  const [statusResult, diagnosticsResult] = await Promise.allSettled([
    api('/api/integrations/status'),
    api('/api/system/diagnostics'),
  ]);
  if (statusResult.status === 'fulfilled') {
    state.integrations = statusResult.value.integrations;
    paintMapsBadge();
  }
  if (diagnosticsResult.status === 'fulfilled') {
    state.settingsCache.diagnostics = diagnosticsResult.value.diagnostics;
  } else {
    state.settingsCache.diagnostics = { error: errorMessage(diagnosticsResult.reason) };
  }
  rerender();
}

function openDeleteAccountModal() {
  openModalShell(
    `
    <form data-form="delete-account" novalidate>
      <div class="modal-head">
        <div class="modal-head-main">
          <h2 id="delete-account-title">Excluir conta permanentemente</h2>
          <p>Todos os leads, pesquisas e históricos serão removidos.</p>
        </div>
        <button class="btn btn-ghost btn-icon" type="button" data-action="close-modal" aria-label="Fechar">×</button>
      </div>
      <div class="modal-body">
        <div class="notice notice-danger" style="margin-bottom:14px"><span>Esta ação é irreversível. Confirme sua senha para continuar.</span></div>
        <label class="field">
          <span>Senha atual</span>
          <input type="password" name="password" required maxlength="128" autocomplete="current-password" autofocus />
        </label>
        <p class="form-error" data-form-error role="alert" hidden></p>
      </div>
      <div class="modal-foot">
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancelar</button>
        <button class="btn btn-danger" type="submit">Excluir definitivamente</button>
      </div>
    </form>`,
    'modal-sm',
  );
}

export async function handleAdvancedSettingsAction(element, rerender) {
  const action = element.dataset.action;

  if (action === 'settings-delete-account') {
    openDeleteAccountModal();
    return true;
  }

  if (action === 'settings-refresh-diagnostics') {
    void loadIntegrationsTabData(rerender);
    return true;
  }

  if (action === 'settings-test-maps') {
    if (state.settingsCache.mapsTesting) return true;
    state.settingsCache.mapsTesting = true;
    state.settingsCache.mapsTest = null;
    rerender();
    try {
      const result = await api('/api/integrations/discovery/test', { method: 'POST' });
      state.settingsCache.mapsTest = {
        ok: true,
        latencyMs: result.latencyMs,
      };
      toast(`Serviço de pesquisa respondeu em ${fmtNumber(result.latencyMs)} ms.`, 'success');
      await refreshIntegrations();
    } catch (error) {
      state.settingsCache.mapsTest = { ok: false, message: errorMessage(error) };
      toast(errorMessage(error), 'error');
    } finally {
      state.settingsCache.mapsTesting = false;
      rerender();
    }
    return true;
  }

  if (action === 'settings-revoke-session') {
    const id = element.dataset.id;
    const isCurrent = element.dataset.current === 'true';
    if (!id) return true;
    if (!window.confirm(isCurrent ? 'Encerrar esta sessão e sair agora?' : 'Encerrar esta sessão?'))
      return true;
    void (async () => {
      try {
        await api(`/api/account/sessions/${encodeURIComponent(id)}`, { method: 'DELETE' });
        if (isCurrent) {
          window.dispatchEvent(new CustomEvent('auth:expired'));
        } else {
          toast('Sessão encerrada.', 'success');
          await loadSecurityTabData(rerender);
        }
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    })();
    return true;
  }

  if (action === 'settings-logout-all') {
    if (!window.confirm('Encerrar todas as sessões, incluindo esta? Você precisará entrar novamente.'))
      return true;
    void (async () => {
      try {
        await api('/api/account/logout-all', { method: 'POST' });
        window.dispatchEvent(new CustomEvent('auth:expired'));
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    })();
    return true;
  }

  if (action === 'settings-resend-verification') {
    if (emailConfigured() === false) {
      toast('SMTP não configurado no servidor.', 'warning');
      return true;
    }
    void (async () => {
      try {
        const result = await api('/api/auth/resend-verification', { method: 'POST' });
        toast(result.message || 'Se o SMTP estiver operacional, o e-mail foi enviado.', 'success');
      } catch (error) {
        toast(errorMessage(error), 'error');
      }
    })();
    return true;
  }

  return false;
}

export async function handleAdvancedSettingsSubmit(form) {
  const kind = form.dataset.form;

  if (kind === 'settings-password') {
    clearFormMessages(form);
    const data = Object.fromEntries(new FormData(form).entries());
    if (String(data.newPassword ?? '') !== String(data.confirmPassword ?? '')) {
      showFormError(form, 'A confirmação não corresponde à nova senha.');
      return true;
    }
    setFormBusy(form, true, 'Alterando...');
    try {
      await api('/api/account/password', {
        method: 'POST',
        body: { currentPassword: data.currentPassword, newPassword: data.newPassword },
      });
      form.reset();
      state.settingsCache.sessions = null;
      toast('Senha alterada. As outras sessões foram encerradas.', 'success');
      const dataNow = await api('/api/account/sessions').catch(() => null);
      if (dataNow) state.settingsCache.sessions = dataNow.sessions;
      if (state.route === 'settings' && state.settingsTab === 'security') {
        window.dispatchEvent(new CustomEvent('settings:rerender'));
      }
    } catch (error) {
      showFormError(form, errorMessage(error));
    } finally {
      setFormBusy(form, false);
    }
    return true;
  }

  if (kind === 'delete-account') {
    clearFormMessages(form);
    const data = Object.fromEntries(new FormData(form).entries());
    if (!data.password) {
      showFormError(form, 'Informe sua senha.');
      return true;
    }
    setFormBusy(form, true, 'Excluindo...');
    try {
      await api('/api/account', { method: 'DELETE', body: { password: data.password } });
      closeModal({ updateHash: false });
      window.dispatchEvent(new CustomEvent('auth:deleted'));
    } catch (error) {
      showFormError(form, errorMessage(error));
      setFormBusy(form, false);
    }
    return true;
  }

  return false;
}
