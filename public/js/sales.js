const plansGrid = document.getElementById('plans-grid');
const billingWarning = document.getElementById('billing-warning');
const comparisonSection = document.getElementById('comparison-section');
const comparisonBody = document.getElementById('comparison-body');
const statusBox = document.getElementById('sales-status');
const accountSummary = document.getElementById('account-summary');

const state = {
  plans: [],
  comparison: [],
  billing: null,
  creditUnit: '',
  user: null,
};

const numberFormatter = new Intl.NumberFormat('pt-BR');
const dateFormatter = new Intl.DateTimeFormat('pt-BR', { dateStyle: 'long' });

function esc(value) {
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

function formatNumber(value) {
  return numberFormatter.format(Number(value) || 0);
}

function formatDate(value) {
  if (!value) return null;
  try {
    return dateFormatter.format(new Date(value));
  } catch {
    return null;
  }
}

function showStatus(message, { error = false, html = false } = {}) {
  if (!statusBox) return;
  statusBox.hidden = false;
  statusBox.classList.toggle('is-error', error);
  if (html) statusBox.innerHTML = message;
  else statusBox.textContent = message;
}

function hideStatus() {
  if (!statusBox) return;
  statusBox.hidden = true;
  statusBox.textContent = '';
}

async function readJson(response) {
  return response.json().catch(() => ({}));
}

async function csrfToken() {
  const response = await fetch('/api/auth/csrf', {
    credentials: 'same-origin',
    headers: { Accept: 'application/json' },
    cache: 'no-store',
  });
  if (!response.ok) throw new Error('Não foi possível iniciar o checkout.');
  const data = await readJson(response);
  if (!data || !data.csrfToken) throw new Error('Não foi possível iniciar o checkout.');
  return data.csrfToken;
}

async function loadSession() {
  try {
    const response = await fetch('/api/auth/me', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) return null;
    const data = await readJson(response);
    return data?.user ?? null;
  } catch {
    return null;
  }
}

async function loadCatalog() {
  try {
    const response = await fetch('/api/billing/plans', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!response.ok) throw new Error('Não foi possível carregar os planos.');
    const data = await readJson(response);
    state.plans = Array.isArray(data.plans) ? data.plans : [];
    state.comparison = Array.isArray(data.comparison) ? data.comparison : [];
    state.billing = data.billing ?? null;
    state.creditUnit = data.creditUnit ?? '';
  } catch (error) {
    plansGrid.innerHTML = `<div class="card warning"><p>${esc(
      error instanceof Error ? error.message : 'Não foi possível carregar os planos.',
    )}</p><p><a href="/contact">Fale com o suporte</a> para contratar um plano.</p></div>`;
    throw error;
  }
}

function planActionLabel(plan) {
  if (state.user?.isSuperAdmin) return 'Acesso administrativo';
  if (state.user?.planId === plan.id && state.user?.active) return 'Plano atual';
  if (state.billing && state.billing.configured === false) return 'Pagamento em configuração';
  return `Assinar ${plan.name}`;
}

function planActionDisabled(plan) {
  if (state.user?.isSuperAdmin) return true;
  if (state.user?.planId === plan.id && state.user?.active) return true;
  if (state.billing && state.billing.configured === false) return true;
  return false;
}

function renderPlans() {
  if (!state.plans.length) {
    plansGrid.innerHTML = '<p class="muted">Nenhum plano disponível no momento.</p>';
    return;
  }

  plansGrid.innerHTML = state.plans
    .map(
      (plan) => `
      <article class="plan-card${plan.highlight ? ' is-highlight' : ''}">
        ${plan.highlight ? '<span class="plan-tag">Mais escolhido</span>' : ''}
        <h3>${esc(plan.name)}</h3>
        <p class="plan-description">${esc(plan.description)}</p>
        <p class="plan-price">${esc(plan.priceLabel)}<span> /mês</span></p>
        <p class="plan-credits">${esc(plan.creditsLabel)}</p>
        <ul class="plan-features">
          ${(plan.features ?? []).map((feature) => `<li>${esc(feature)}</li>`).join('')}
        </ul>
        <div class="plan-action">
          <button
            class="plan-button"
            type="button"
            data-plan="${esc(plan.id)}"
            ${planActionDisabled(plan) ? 'disabled' : ''}
          >${esc(planActionLabel(plan))}</button>
          <p class="plan-note">Renovação mensal. Cancele quando quiser.</p>
        </div>
      </article>`,
    )
    .join('');
}

function renderComparison() {
  if (!state.comparison.length || !state.plans.length) {
    comparisonSection.hidden = true;
    return;
  }

  const planById = new Map(state.plans.map((plan) => [plan.id, plan]));
  document.querySelectorAll('[data-plan-head]').forEach((cell) => {
    const plan = planById.get(cell.dataset.planHead);
    if (plan) cell.textContent = plan.name;
  });

  comparisonBody.innerHTML = state.comparison
    .map(
      (row) => `
      <tr>
        <th scope="row">${esc(row.label)}</th>
        <td>${esc(row.values?.starter ?? '—')}</td>
        <td>${esc(row.values?.pro ?? '—')}</td>
        <td>${esc(row.values?.business ?? '—')}</td>
      </tr>`,
    )
    .join('');
  comparisonSection.hidden = false;
}

function renderBillingWarning() {
  if (!billingWarning) return;
  if (state.billing && state.billing.configured === false) {
    billingWarning.hidden = false;
    billingWarning.innerHTML = `<p>O pagamento online ainda está sendo configurado no servidor. Enquanto isso, solicite a contratação pela <a href="/contact">página de contato</a>.</p>`;
  } else {
    billingWarning.hidden = true;
  }
}

function renderAccountSummary() {
  if (!accountSummary) return;
  const user = state.user;
  if (!user) {
    accountSummary.hidden = true;
    return;
  }

  accountSummary.hidden = false;

  if (user.isSuperAdmin) {
    accountSummary.innerHTML = `
      <div>
        <strong>Acesso administrativo</strong>
        <p class="meta" style="margin:4px 0 0">Esta conta possui acesso completo e não precisa de assinatura.</p>
      </div>
      <a class="btn" href="/#/settings">Abrir configurações</a>`;
    return;
  }

  const renew = formatDate(user.renewsAt);
  let planLine = 'Sem plano ativo';
  let creditsLine = '—';
  let statusLine = 'Somente leitura';

  if (user.planId) {
    planLine = user.planName ? `${user.planName}` : user.planId;
    creditsLine = user.unlimited
      ? 'Ilimitados'
      : `${formatNumber(user.creditsRemaining)} de ${formatNumber(user.creditsLimit)}`;
    if (user.canSearch) statusLine = 'Pesquisas liberadas';
    else if (Number(user.creditsRemaining) <= 0) statusLine = 'Créditos esgotados';
    else statusLine = 'Plano inativo';
  }

  accountSummary.innerHTML = `
    <dl>
      <div><dt>Plano atual</dt><dd>${esc(planLine)}</dd></div>
      <div><dt>Créditos</dt><dd>${esc(creditsLine)}</dd></div>
      <div><dt>Status</dt><dd>${esc(statusLine)}</dd></div>
      <div><dt>Renovação</dt><dd>${esc(renew ?? '—')}</dd></div>
    </dl>
    <a class="btn" href="/#/settings">Gerenciar no aplicativo</a>`;
}

function renderAll() {
  renderPlans();
  renderComparison();
  renderBillingWarning();
  renderAccountSummary();
}

async function startCheckout(planId, button) {
  if (!state.user) {
    window.location.href = '/#/login';
    return;
  }

  const plan = state.plans.find((item) => item.id === planId);
  if (!plan) return;

  const original = button.textContent;
  button.disabled = true;
  button.textContent = 'Abrindo checkout...';
  hideStatus();

  try {
    const token = await csrfToken();
    const response = await fetch('/api/billing/checkout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': token,
        Accept: 'application/json',
      },
      body: JSON.stringify({ planId }),
    });
    const data = await readJson(response);

    if (response.status === 401) {
      window.location.href = '/#/login';
      return;
    }

    if (!response.ok) {
      const message =
        data?.error?.message || 'Não foi possível iniciar o checkout. Tente novamente.';
      if (data?.error?.code === 'BILLING_NOT_CONFIGURED') {
        showStatus(
          `${esc(message)} <a href="/contact">Fale com o suporte</a> para contratar.`,
          { error: true, html: true },
        );
      } else {
        showStatus(message, { error: true });
      }
      button.disabled = false;
      button.textContent = original;
      return;
    }

    if (!data?.checkoutUrl) throw new Error('Checkout sem URL de pagamento.');
    window.location.assign(data.checkoutUrl);
  } catch (error) {
    showStatus(
      error instanceof Error ? error.message : 'Não foi possível iniciar o checkout.',
      { error: true },
    );
    button.disabled = false;
    button.textContent = original;
  }
}

async function pollActivation(attempt = 0) {
  if (attempt > 5) return;
  const user = await loadSession();
  if (user?.planId && user?.active) {
    state.user = user;
    renderAll();
    showStatus('Pagamento confirmado. Seu plano está ativo.', { error: false });
    return;
  }
  window.setTimeout(() => void pollActivation(attempt + 1), 3000);
}

function handleQueryState() {
  const params = new URLSearchParams(window.location.search);
  const checkout = params.get('checkout');

  if (checkout === 'success') {
    showStatus(
      'Pagamento concluído. A ativação do plano pode levar alguns segundos. Esta página será atualizada automaticamente.',
    );
    void pollActivation();
  } else if (checkout === 'cancelled') {
    showStatus('Checkout cancelado. Nenhuma cobrança foi realizada.');
  } else if (checkout === 'error') {
    showStatus('Não foi possível concluir o checkout. Tente novamente ou fale com o suporte.', {
      error: true,
    });
  }
}

plansGrid.addEventListener('click', (event) => {
  const button = event.target.closest('[data-plan]');
  if (!button || button.disabled) return;
  void startCheckout(button.dataset.plan, button);
});

async function init() {
  await loadCatalog();
  state.user = await loadSession();
  renderAll();
  handleQueryState();
  if (state.creditUnit) {
    const note = document.createElement('p');
    note.className = 'meta';
    note.style.marginTop = '18px';
    note.textContent = state.creditUnit;
    plansGrid.after(note);
  }
}

void init();
