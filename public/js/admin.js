import { api, emptyState, errorMessage, esc, state, toast } from './core.js';

const PLAN_OPTIONS = [
  ['starter', 'Starter — 300 créditos'],
  ['pro', 'Pro — 1.000 créditos'],
  ['business', 'Business — 5.000 créditos'],
];

function cache() {
  return state.settingsCache.admin;
}

function fmtDate(value) {
  if (!value) return '—';
  try {
    return new Intl.DateTimeFormat('pt-BR', { dateStyle: 'short', timeStyle: 'short' }).format(
      new Date(value),
    );
  } catch {
    return '—';
  }
}

function fmtNumber(value) {
  return new Intl.NumberFormat('pt-BR').format(Number(value) || 0);
}

export function adminTabMarkup() {
  const data = cache();
  if (!data || data.loading) {
    return `<div class="settings-panel"><section class="settings-section"><p class="muted">Carregando dados administrativos...</p></section></div>`;
  }
  if (data.error) {
    return `<div class="settings-panel"><section class="settings-section">${emptyState(
      'Não foi possível carregar o painel administrativo',
      data.error,
      '<button class="btn" type="button" data-action="admin-refresh">Tentar novamente</button>',
    )}</section></div>`;
  }

  const stats = data.stats ?? {};
  const users = data.users ?? [];
  const selected = data.selected;

  return `
    <div class="settings-panel">
      <section class="settings-section">
        <div class="row" style="justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <h3>Administração</h3>
            <p class="small muted">Área exclusiva do super administrador provisionado no servidor. Toda ação é auditada.</p>
          </div>
          <button class="btn" type="button" data-action="admin-refresh">Atualizar</button>
        </div>
        <div class="grid-2" style="margin-top:14px">
          <div class="panel" style="margin:0"><div class="panel-body"><p class="small muted">Usuários</p><p><strong>${fmtNumber(stats.users)}</strong></p></div></div>
          <div class="panel" style="margin:0"><div class="panel-body"><p class="small muted">Assinaturas ativas</p><p><strong>${fmtNumber(stats.activeSubscriptions)}</strong></p></div></div>
        </div>
        <p class="small muted" style="margin-top:10px">Starter: ${fmtNumber(stats.byPlan?.starter)} · Pro: ${fmtNumber(stats.byPlan?.pro)} · Business: ${fmtNumber(stats.byPlan?.business)}</p>
      </section>

      <section class="settings-section">
        <h3>Usuários</h3>
        <form class="row" data-form="settings-admin-search" style="gap:8px;margin-bottom:12px">
          <input type="search" name="q" maxlength="120" placeholder="Buscar por nome ou e-mail" value="${esc(data.q ?? '')}" style="flex:1" />
          <button class="btn" type="submit">Buscar</button>
        </form>
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>Usuário</th><th>Plano</th><th>Créditos</th><th>Status</th><th></th></tr></thead>
            <tbody>
              ${
                users.length
                  ? users
                      .map(
                        (user) => `
                <tr>
                  <td><strong>${esc(user.name)}</strong><br /><span class="small muted">${esc(user.email)}</span></td>
                  <td>${user.planName ? esc(user.planName) : '<span class="muted">Sem plano</span>'}</td>
                  <td>${fmtNumber(user.creditsRemaining)} / ${fmtNumber(user.creditsLimit)}</td>
                  <td>${esc(user.status ?? '—')}</td>
                  <td><button class="btn btn-ghost" type="button" data-action="admin-select" data-id="${esc(user.id)}">Gerenciar</button></td>
                </tr>`,
                      )
                      .join('')
                  : '<tr><td colspan="5"><span class="muted">Nenhum usuário encontrado.</span></td></tr>'
              }
            </tbody>
          </table>
        </div>
      </section>

      ${
        selected
          ? `
      <section class="settings-section">
        <div class="row" style="justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
          <div>
            <h3>${esc(selected.user.name)}</h3>
            <p class="small muted">${esc(selected.user.email)} · ${esc(selected.user.role)}</p>
          </div>
          <button class="btn btn-ghost" type="button" data-action="admin-clear">Fechar detalhe</button>
        </div>
        <dl class="kv small">
          <dt>Plano</dt><dd>${selected.user.planName ? esc(selected.user.planName) : 'Sem plano'}</dd>
          <dt>Créditos</dt><dd>${fmtNumber(selected.user.creditsRemaining)} de ${fmtNumber(selected.user.creditsLimit)}</dd>
          <dt>Status</dt><dd>${esc(selected.user.status ?? '—')}</dd>
          <dt>Período termina</dt><dd>${fmtDate(selected.user.currentPeriodEnd)}</dd>
          <dt>Provedor</dt><dd>${esc(selected.user.provider ?? 'manual')}</dd>
        </dl>

        <div class="grid-2" style="margin-top:16px">
          <form class="form-stack" data-form="settings-admin-plan">
            <input type="hidden" name="userId" value="${esc(selected.user.id)}" />
            <h4>Conceder plano manualmente</h4>
            <label class="field"><span>Plano</span>
              <select name="planId">${PLAN_OPTIONS.map(([id, label]) => `<option value="${id}">${label}</option>`).join('')}</select>
            </label>
            <label class="field"><span>Dias de acesso</span><input type="number" name="days" min="1" max="366" value="30" /></label>
            <button class="btn btn-primary" type="submit">Conceder plano</button>
          </form>

          <form class="form-stack" data-form="settings-admin-credits">
            <input type="hidden" name="userId" value="${esc(selected.user.id)}" />
            <h4>Ajustar créditos</h4>
            <label class="field"><span>Ajuste (positivo ou negativo)</span><input type="number" name="delta" min="-1000000" max="1000000" value="0" required /></label>
            <label class="field"><span>Motivo (auditado)</span><input type="text" name="reason" minlength="3" maxlength="500" required /></label>
            <button class="btn" type="submit">Aplicar ajuste</button>
          </form>
        </div>

        <form class="form-stack" data-form="settings-admin-cancel" style="margin-top:16px">
          <input type="hidden" name="userId" value="${esc(selected.user.id)}" />
          <h4>Cancelar assinatura</h4>
          <label class="check-row"><input type="checkbox" name="immediate" value="true" /> Cancelamento imediato (sem provedor externo o cancelamento é sempre imediato)</label>
          <button class="btn btn-danger" type="submit">Cancelar assinatura</button>
        </form>

        <h4 style="margin-top:22px">Histórico de créditos</h4>
        <ul class="list small">
          ${
            selected.credits?.length
              ? selected.credits
                  .map(
                    (item) =>
                      `<li><strong>${esc(item.type)}</strong> ${item.amount > 0 ? '+' : ''}${fmtNumber(item.amount)} · saldo ${fmtNumber(item.balanceAfter)} · ${esc(item.description ?? '')} <span class="muted">(${fmtDate(item.createdAt)})</span></li>`,
                  )
                  .join('')
              : '<li class="muted">Nenhum lançamento.</li>'
          }
        </ul>
      </section>`
          : ''
      }

      <section class="settings-section">
        <h3>Auditoria recente</h3>
        <ul class="list small">
          ${
            data.audit?.length
              ? data.audit
                  .map(
                    (event) =>
                      `<li><strong>${esc(event.action)}</strong> · ${esc(event.email ?? 'sistema')} · ${fmtDate(event.createdAt)}</li>`,
                  )
                  .join('')
              : '<li class="muted">Nenhum evento.</li>'
          }
        </ul>
      </section>
    </div>`;
}

export async function loadAdminTabData(rerender) {
  const previous = cache();
  state.settingsCache.admin = {
    ...(previous ?? {}),
    loading: true,
    error: null,
    q: previous?.q ?? '',
    page: previous?.page ?? 1,
  };
  rerender?.();
  try {
    const query = new URLSearchParams({
      page: String(previous?.page ?? 1),
      pageSize: '25',
    });
    if (previous?.q) query.set('q', previous.q);
    const [stats, users, audit] = await Promise.all([
      api('/api/admin/stats'),
      api(`/api/admin/users?${query.toString()}`),
      api('/api/admin/audit?limit=25'),
    ]);
    state.settingsCache.admin = {
      loading: false,
      error: null,
      stats,
      users: users.users ?? [],
      total: users.total ?? 0,
      page: users.page ?? 1,
      q: previous?.q ?? '',
      audit: audit.events ?? [],
      selected: previous?.selected ?? null,
    };
  } catch (error) {
    state.settingsCache.admin = {
      ...(previous ?? {}),
      loading: false,
      error: errorMessage(error),
    };
  }
  rerender?.();
}

async function selectUser(id, rerender) {
  const data = cache();
  if (!data) return;
  state.settingsCache.admin = { ...data, loading: true, error: null };
  rerender?.();
  try {
    const detail = await api(`/api/admin/users/${encodeURIComponent(id)}`);
    state.settingsCache.admin = {
      ...(cache() ?? data),
      loading: false,
      error: null,
      selected: detail,
    };
  } catch (error) {
    state.settingsCache.admin = { ...(cache() ?? data), loading: false, error: errorMessage(error) };
  }
  rerender?.();
}

async function refresh(rerender) {
  const data = cache();
  state.settingsCache.admin = { ...(data ?? {}), q: data?.q ?? '', page: data?.page ?? 1 };
  await loadAdminTabData(rerender);
}

export async function handleAdminAction(element, rerender) {
  const action = element.dataset.action;
  if (action === 'admin-refresh') {
    await refresh(rerender);
    return true;
  }
  if (action === 'admin-select') {
    await selectUser(element.dataset.id, rerender);
    return true;
  }
  if (action === 'admin-clear') {
    const data = cache();
    if (data) state.settingsCache.admin = { ...data, selected: null };
    rerender?.();
    return true;
  }
  return false;
}

export async function handleAdminSubmit(form) {
  const kind = form.dataset.form;
  if (!kind || !kind.startsWith('settings-admin-')) return false;

  const data = Object.fromEntries(new FormData(form).entries());

  if (kind === 'settings-admin-search') {
    const current = cache() ?? {};
    state.settingsCache.admin = { ...current, q: String(data.q ?? '').trim(), page: 1 };
    await loadAdminTabData(() => {});
    // A aba e re-renderizada pelo fluxo global de settings apos o submit.
    if (state.route === 'settings' && state.settingsTab === 'admin') {
      const { renderSettingsTab } = await import('./settings.js');
      renderSettingsTab();
    }
    return true;
  }

  const userId = String(data.userId ?? '');
  if (!userId) return true;

  try {
    if (kind === 'settings-admin-plan') {
      await api(`/api/admin/users/${encodeURIComponent(userId)}/plan`, {
        method: 'POST',
        body: {
          planId: String(data.planId ?? ''),
          days: Number(data.days) || 30,
        },
      });
      toast('Plano concedido e auditado.', 'success');
    } else if (kind === 'settings-admin-credits') {
      const delta = Number(data.delta);
      if (!Number.isFinite(delta) || delta === 0) {
        toast('Informe um ajuste diferente de zero.', 'warning');
        return true;
      }
      await api(`/api/admin/users/${encodeURIComponent(userId)}/credits`, {
        method: 'POST',
        body: { delta, reason: String(data.reason ?? '').trim() },
      });
      toast('Créditos ajustados e auditados.', 'success');
    } else if (kind === 'settings-admin-cancel') {
      await api(`/api/admin/users/${encodeURIComponent(userId)}/cancel`, {
        method: 'POST',
        body: { immediate: data.immediate === 'true' },
      });
      toast('Assinatura cancelada.', 'warning');
    }
    await selectUser(userId, () => {});
    const { renderSettingsTab } = await import('./settings.js');
    renderSettingsTab();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
  return true;
}
