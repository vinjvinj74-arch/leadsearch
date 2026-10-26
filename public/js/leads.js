import {
  LEAD_STATUSES,
  STATUS_LABELS,
  WEBSITE_LABELS,
  WEBSITE_STATUSES,
  api,
  clearFormMessages,
  DEFAULT_FILTERS,
  dom,
  emptyState,
  errorMessage,
  esc,
  fmtNumber,
  fmtRelative,
  option,
  pageSkeleton,
  scorePill,
  selectedExportFields,
  state,
  statusBadge,
  toast,
  websiteBadge,
} from './core.js';

function buildLeadQuery(includePaging = false) {
  const params = new URLSearchParams();
  const filters = state.leads.filters;
  if (filters.q) params.set('q', filters.q);
  if (filters.status) params.set('status', filters.status);
  if (filters.websiteStatus) params.set('websiteStatus', filters.websiteStatus);
  if (filters.hasWebsite) params.set('hasWebsite', filters.hasWebsite);
  if (filters.minScore) params.set('minScore', filters.minScore);
  if (filters.searchId) params.set('searchId', filters.searchId);
  if (filters.sort) params.set('sort', filters.sort);
  if (filters.order) params.set('order', filters.order);
  if (includePaging) {
    params.set('page', state.leads.page);
    params.set('pageSize', state.leads.pageSize);
  }
  return params;
}

function filtersActive() {
  const filters = state.leads.filters;
  return Boolean(
    filters.q ||
    filters.status ||
    filters.websiteStatus ||
    filters.hasWebsite ||
    filters.minScore ||
    filters.searchId,
  );
}

function exportLeads(ids) {
  const params = buildLeadQuery(false);
  if (ids?.length) params.set('ids', ids.join(','));
  params.set('fields', selectedExportFields().join(','));
  window.location.href = `/api/leads/export.csv?${params.toString()}`;
  toast('Exportação iniciada. O download do CSV deve começar em instantes.', 'info');
}

function leadsTableMarkup() {
  const data = state.leads.data;
  if (state.leads.loading || !data) {
    return `
      <div style="padding:18px">
        <div class="skeleton skeleton-line" style="width:40%"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line"></div>
        <div class="skeleton skeleton-line" style="width:70%"></div>
      </div>`;
  }

  if (!data.leads.length) {
    return emptyState(
      filtersActive() ? 'Nenhum lead encontrado' : 'Sua base está vazia',
      filtersActive()
        ? 'Ajuste os filtros ou limpe a seleção para ver todos os leads.'
        : 'Execute uma prospecção para encontrar empresas e iniciar seu funil.',
      filtersActive()
        ? '<button class="btn" type="button" data-action="leads-clear">Limpar filtros</button>'
        : '<a class="btn btn-primary" href="#/search">Fazer primeira pesquisa</a>',
    );
  }

  const selected = state.leads.selected;
  return `
    <div class="bulk-bar" id="leads-bulk-bar" ${selected.size ? '' : 'hidden'}>
      <strong><span id="leads-selected-count">${selected.size}</span> selecionado(s)</strong>
      <button class="btn btn-sm" type="button" data-action="leads-export-selected">Exportar selecionados</button>
      <button class="btn btn-sm btn-ghost" type="button" data-action="leads-clear-selection">Limpar seleção</button>
    </div>
    <div class="table-wrap">
      <table class="data-table">
        <thead>
          <tr>
            <th style="width:36px"><input type="checkbox" id="leads-select-all" aria-label="Selecionar todos os leads desta página" /></th>
            <th>Empresa</th>
            <th>Contato</th>
            <th>Site</th>
            <th>Score</th>
            <th>Status</th>
            <th>Atualizado</th>
          </tr>
        </thead>
        <tbody>
          ${data.leads
            .map((lead) => {
              const isSelected = selected.has(lead.id);
              return `
                <tr class="is-clickable" data-lead-id="${esc(lead.id)}" tabindex="0">
                  <td class="cell-select"><input type="checkbox" data-lead-select value="${esc(lead.id)}" aria-label="Selecionar ${esc(lead.name)}" ${isSelected ? 'checked' : ''} /></td>
                  <td class="cell-company">
                    <div class="cell-main">
                      <strong>${esc(lead.name)}</strong>
                      <small>${esc(lead.segment || 'Segmento não informado')} · ${esc([lead.city, lead.state].filter(Boolean).join('/') || 'Local não informado')}</small>
                    </div>
                  </td>
                  <td class="cell-contact-cell">
                    <div class="cell-contact">
                      <span>${lead.phone ? esc(lead.phone) : '<span class="muted">Sem telefone</span>'}</span>
                      <span>${lead.email ? esc(lead.email) : '<span class="muted">Sem e-mail</span>'}</span>
                    </div>
                  </td>
                  <td class="cell-site" data-label="Site">${websiteBadge(lead.websiteStatus)}</td>
                  <td class="cell-score" data-label="Score">${scorePill(lead.effectiveScore)}</td>
                  <td class="cell-status" data-label="Status">${statusBadge(lead.status)}</td>
                  <td class="cell-updated nowrap small muted" data-label="Atualizado">${esc(fmtRelative(lead.updatedAt))}</td>
                </tr>`;
            })
            .join('')}
        </tbody>
      </table>
    </div>
    <div class="pagination">
      <span class="small">${fmtNumber(data.pagination.total)} lead(s) · página ${data.pagination.page} de ${data.pagination.totalPages}</span>
      <div class="row">
        <button class="btn btn-sm" type="button" data-action="leads-page" data-page="${data.pagination.page - 1}" ${data.pagination.page <= 1 ? 'disabled' : ''}>Anterior</button>
        <button class="btn btn-sm" type="button" data-action="leads-page" data-page="${data.pagination.page + 1}" ${data.pagination.page >= data.pagination.totalPages ? 'disabled' : ''}>Próxima</button>
      </div>
    </div>`;
}

function leadsViewMarkup() {
  const filters = state.leads.filters;
  const total = state.leads.data?.pagination?.total;
  const searchFilter = filters.searchId
    ? `<span class="badge badge-accent">Pesquisa específica <button class="link-button" style="margin-left:6px;color:inherit" type="button" data-action="leads-clear-search" aria-label="Remover filtro de pesquisa">×</button></span>`
    : '';
  return `
    <div class="stack">
      <div class="row-between">
        <div>
          <h2 style="font-size:18px">${filtersActive() ? 'Leads filtrados' : 'Todos os leads'}</h2>
          <p class="small muted">${total === undefined ? 'Carregando...' : `${fmtNumber(total)} lead(s) ${filtersActive() ? 'com os filtros atuais' : 'na sua base'}`}</p>
        </div>
        <div class="row">
          ${searchFilter}
          <button class="btn btn-sm" type="button" data-action="leads-export">Exportar CSV</button>
        </div>
      </div>

      <section class="panel">
        <form class="table-toolbar" data-form="leads-filters">
          <div class="filters">
            <label class="field field-search">
              <span>Buscar</span>
              <input type="search" name="q" value="${esc(filters.q)}" placeholder="Nome, e-mail, telefone, site..." maxlength="200" />
            </label>
            <label class="field">
              <span>Status</span>
              <select name="status">${option('', 'Todos', filters.status)}${LEAD_STATUSES.map((status) => option(status, STATUS_LABELS[status], filters.status)).join('')}</select>
            </label>
            <label class="field">
              <span>Site</span>
              <select name="websiteStatus">${option('', 'Todos', filters.websiteStatus)}${WEBSITE_STATUSES.map((status) => option(status, WEBSITE_LABELS[status], filters.websiteStatus)).join('')}</select>
            </label>
            <label class="field">
              <span>Possui site</span>
              <select name="hasWebsite">${option('', 'Todos', filters.hasWebsite)}${option('yes', 'Sim', filters.hasWebsite)}${option('no', 'Não', filters.hasWebsite)}</select>
            </label>
            <label class="field">
              <span>Score mínimo</span>
              <input type="number" name="minScore" min="0" max="100" value="${esc(filters.minScore)}" placeholder="0" />
            </label>
            <label class="field">
              <span>Ordenar</span>
              <select name="sort">
                ${option('created_at', 'Mais recentes', filters.sort)}
                ${option('score', 'Maior pontuação', filters.sort)}
                ${option('updated_at', 'Atualizados', filters.sort)}
                ${option('name', 'Nome A-Z', filters.sort)}
                ${option('last_checked_at', 'Última verificação', filters.sort)}
                ${option('status', 'Status', filters.sort)}
              </select>
            </label>
          </div>
          <div class="row">
            <button class="btn btn-primary btn-sm" type="submit">Aplicar</button>
            <button class="btn btn-ghost btn-sm" type="button" data-action="leads-clear">Limpar</button>
          </div>
        </form>
        <div id="leads-table-region">${leadsTableMarkup()}</div>
        <div class="pagination">
          <label class="field small" style="flex-direction:row;align-items:center;gap:8px;font-weight:400">
            <span class="muted">Itens por página</span>
            <select class="input" style="width:82px;min-height:32px;padding:4px 8px" data-change="leads-page-size">
              ${[10, 25, 50, 100].map((value) => option(value, value, state.leads.pageSize)).join('')}
            </select>
          </label>
          <span class="small muted">Clique em um lead para abrir o detalhe.</span>
        </div>
      </section>
    </div>`;
}

function renderLeadsView() {
  if (state.route !== 'leads') return;
  dom.main.innerHTML = leadsViewMarkup();
  syncSelectionUi();
}

export async function loadLeads(showSkeleton = true) {
  const seq = ++state.leads.seq;
  state.leads.loading = showSkeleton;
  if (showSkeleton) renderLeadsView();
  try {
    const data = await api(`/api/leads?${buildLeadQuery(true).toString()}`);
    if (seq !== state.leads.seq || state.route !== 'leads') return;
    if (state.leads.page > data.pagination.totalPages) {
      state.leads.page = data.pagination.totalPages;
      await loadLeads(showSkeleton);
      return;
    }
    state.leads.data = data;
    state.leads.loading = false;
    state.leads.selected.clear();
    renderLeadsView();
  } catch (error) {
    if (seq !== state.leads.seq || state.route !== 'leads') return;
    state.leads.loading = false;
    state.leads.data = null;
    dom.main.innerHTML = `
      <section class="panel">
        <div class="panel-body">${emptyState('Não foi possível carregar os leads', errorMessage(error), '<button class="btn" type="button" data-action="retry-route">Tentar novamente</button>')}</div>
      </section>`;
  }
}

export async function renderLeadsRoute() {
  dom.main.innerHTML = pageSkeleton('leads');
  await loadLeads(false);
}

export async function refreshLeadsSilently() {
  if (state.route !== 'leads' || !state.leads.data) return;
  try {
    const data = await api(`/api/leads?${buildLeadQuery(true).toString()}`);
    if (state.route !== 'leads') return;
    if (state.leads.page > data.pagination.totalPages) {
      state.leads.page = data.pagination.totalPages;
      await refreshLeadsSilently();
      return;
    }
    state.leads.data = data;
    const region = document.getElementById('leads-table-region');
    if (region) region.innerHTML = leadsTableMarkup();
    syncSelectionUi();
  } catch {
    return;
  }
}

function syncSelectionUi() {
  const selected = state.leads.selected;
  const count = selected.size;
  const bar = document.getElementById('leads-bulk-bar');
  if (bar) bar.hidden = count === 0;
  const counter = document.getElementById('leads-selected-count');
  if (counter) counter.textContent = count;
  document.querySelectorAll('[data-lead-select]').forEach((checkbox) => {
    checkbox.checked = selected.has(checkbox.value);
  });
  const selectAll = document.getElementById('leads-select-all');
  if (selectAll) {
    const boxes = [...document.querySelectorAll('[data-lead-select]')];
    selectAll.checked = boxes.length > 0 && boxes.every((box) => box.checked);
    selectAll.indeterminate = boxes.some((box) => box.checked) && !selectAll.checked;
  }
}

export async function handleLeadsSubmit(form) {
  clearFormMessages(form);
  const data = Object.fromEntries(new FormData(form).entries());
  const sort = String(data.sort ?? 'created_at');
  state.leads.filters = {
    ...state.leads.filters,
    q: String(data.q ?? '').trim(),
    status: String(data.status ?? ''),
    websiteStatus: String(data.websiteStatus ?? ''),
    hasWebsite: String(data.hasWebsite ?? ''),
    minScore: String(data.minScore ?? ''),
    sort,
    order: sort === 'name' || sort === 'status' ? 'asc' : 'desc',
  };
  state.leads.page = 1;
  state.leads.selected.clear();
  await loadLeads(true);
}

export function handleLeadsAction(element) {
  const action = element.dataset.action;
  if (action === 'leads-page') {
    const page = Number(element.dataset.page);
    if (!Number.isFinite(page) || page < 1) return true;
    state.leads.page = page;
    state.leads.selected.clear();
    void loadLeads(true);
    return true;
  }
  if (action === 'leads-clear') {
    state.leads.filters = { ...DEFAULT_FILTERS };
    state.leads.page = 1;
    state.leads.selected.clear();
    void loadLeads(true);
    return true;
  }
  if (action === 'leads-clear-search') {
    state.leads.filters = { ...state.leads.filters, searchId: '' };
    state.leads.page = 1;
    state.leads.selected.clear();
    void loadLeads(true);
    return true;
  }
  if (action === 'leads-export') {
    exportLeads();
    return true;
  }
  if (action === 'leads-export-selected') {
    if (!state.leads.selected.size) {
      toast('Selecione pelo menos um lead.', 'warning');
      return true;
    }
    exportLeads([...state.leads.selected]);
    return true;
  }
  if (action === 'leads-clear-selection') {
    state.leads.selected.clear();
    syncSelectionUi();
    return true;
  }
  return false;
}

export function handleLeadsChange(target) {
  if (target.matches('[data-lead-select]')) {
    if (target.checked) state.leads.selected.add(target.value);
    else state.leads.selected.delete(target.value);
    syncSelectionUi();
    return true;
  }
  if (target.id === 'leads-select-all') {
    const boxes = [...document.querySelectorAll('[data-lead-select]')];
    if (target.checked) boxes.forEach((box) => state.leads.selected.add(box.value));
    else state.leads.selected.clear();
    syncSelectionUi();
    return true;
  }
  if (target.matches('[data-change="leads-page-size"]')) {
    state.leads.pageSize = Number(target.value) || 25;
    state.leads.page = 1;
    state.leads.selected.clear();
    void loadLeads(true);
    return true;
  }
  return false;
}
