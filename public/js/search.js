import {
  DEFAULT_FILTERS,
  SEARCH_STATUS_LABELS,
  api,
  dom,
  emptyState,
  errorMessage,
  esc,
  fmtDate,
  fmtNumber,
  fmtRelative,
  mapsConfigured,
  option,
  setFormBusy,
  showFormError,
  state,
  toast,
  clearFormMessages,
} from './core.js';

function favoritesMarkup() {
  const favorites = state.settings?.favoriteNiches ?? [];
  if (!favorites.length) return '';
  return `
    <div class="row" style="margin-top:4px">
      <span class="small muted">Favoritos:</span>
      ${favorites
        .map(
          (niche) =>
            `<button class="badge badge-accent" type="button" data-action="search-fill-niche" data-niche="${esc(niche)}">${esc(niche)}</button>`,
        )
        .join('')}
    </div>`;
}

function searchStatusMarkup() {
  const search = state.activeSearch;
  if (!search) return '';
  const label = SEARCH_STATUS_LABELS[search.status] ?? search.status;
  const isDone = search.status === 'completed';
  const isFailed = search.status === 'failed';
  const pulseClass = isDone ? 'is-done' : isFailed ? 'is-failed' : '';
  const stats = state.activeStats;
  return `
    <div class="search-status">
      <div class="status-header">
        <span class="status-pulse ${pulseClass}" aria-hidden="true"></span>
        <div>
          <h3>${esc(search.niche)} em ${esc([search.city, search.state].filter(Boolean).join(' / '))}</h3>
          <p class="small muted">${esc(label)}${search.status === 'running' || search.status === 'enriching' ? ' · atualizando automaticamente' : ''}</p>
        </div>
      </div>

      ${
        isFailed
          ? `<div class="notice notice-danger"><span><strong>A pesquisa falhou.</strong> ${esc(search.errorMessage || 'Verifique a integração de descoberta e tente novamente.')}</span></div>`
          : ''
      }

      ${
        search.status === 'running' || search.status === 'enriching'
          ? '<div class="notice notice-info"><span>O processamento continua no servidor. Você pode navegar para outra área; os leads aparecerão assim que a pesquisa terminar.</span></div>'
          : ''
      }

      ${
        isDone
          ? `<div class="notice notice-success"><span><strong>Pesquisa concluída.</strong> ${fmtNumber(search.resultsCount)} lead(s) disponível(is)${search.errorMessage ? ` · ${esc(search.errorMessage)}` : ''}.</span></div>`
          : ''
      }

      <div class="row">
        ${
          stats
            ? `<span class="badge">Encontrados: ${fmtNumber(stats.found)}</span>
               <span class="badge badge-success">Novos: ${fmtNumber(stats.created)}</span>
               <span class="badge">Atualizados: ${fmtNumber(stats.updated)}</span>`
            : ''
        }
        <span class="badge">${esc(fmtDate(search.createdAt, true))}</span>
      </div>

      ${search.costNote ? `<p class="small muted">${esc(search.costNote)}</p>` : ''}

      <div class="action-row">
        <button class="btn btn-primary" type="button" data-action="search-view-leads" ${search.resultsCount > 0 ? '' : 'disabled'}>Ver leads desta pesquisa</button>
        <button class="btn btn-ghost" type="button" data-action="search-dismiss">Nova pesquisa</button>
      </div>
    </div>`;
}

export function updateSearchStatusPanel() {
  const panel = document.getElementById('search-status-panel');
  if (!panel) return;
  if (!state.activeSearch) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const body = document.getElementById('search-status-body');
  if (body) body.innerHTML = searchStatusMarkup();
}

export function stopSearchPolling() {
  if (state.searchTimer) {
    window.clearInterval(state.searchTimer);
    state.searchTimer = null;
  }
}

export function startSearchPolling(searchId) {
  stopSearchPolling();
  if (!searchId) return;
  let inFlight = false;
  const timerId = window.setInterval(async () => {
    const stopThis = () => {
      if (state.searchTimer === timerId) stopSearchPolling();
    };
    if (state.route !== 'search') {
      stopThis();
      return;
    }
    if (inFlight) return;
    inFlight = true;
    try {
      const data = await api(`/api/searches/${encodeURIComponent(searchId)}`);
      if (state.activeSearch?.id !== searchId) {
        stopThis();
        return;
      }
      state.activeSearch = data.search;
      updateSearchStatusPanel();
      if (['completed', 'failed'].includes(data.search.status)) {
        stopThis();
        if (data.search.status === 'completed') {
          toast(`Pesquisa concluída: ${fmtNumber(data.search.resultsCount)} lead(s).`, 'success');
        } else {
          toast(`Pesquisa falhou: ${data.search.errorMessage || 'erro desconhecido'}`, 'error', 7000);
        }
        void loadSearchHistory();
      }
    } catch (error) {
      stopThis();
      if (state.activeSearch?.id === searchId) toast(errorMessage(error), 'error');
    } finally {
      inFlight = false;
    }
  }, 2500);
  state.searchTimer = timerId;
}

export async function loadSearchHistory() {
  const container = document.getElementById('search-history-body');
  if (!container) return;
  try {
    const data = await api('/api/searches?limit=12');
    state.searchHistory = data.searches;
    if (state.route !== 'search') return;
    container.innerHTML = data.searches.length
      ? data.searches
          .map(
            (search) => `
            <div class="history-item">
              <div>
                <strong>${esc(search.niche)}</strong>
                <small>${esc([search.city, search.state, search.country].filter(Boolean).join(' / '))} · ${esc(fmtRelative(search.createdAt))}</small>
                <small>${fmtNumber(search.resultsCount)} lead(s) · ${esc(SEARCH_STATUS_LABELS[search.status] ?? search.status)}</small>
              </div>
              <div class="history-actions">
                ${
                  search.resultsCount > 0
                    ? `<button class="btn btn-sm" type="button" data-action="search-filter-leads" data-id="${esc(search.id)}">Leads</button>`
                    : ''
                }
              </div>
            </div>`,
          )
          .join('')
      : emptyState('Nenhuma pesquisa ainda', 'Preencha o formulário ao lado para prospectar empresas.');
  } catch (error) {
    container.innerHTML = `<div class="notice notice-danger"><span>${esc(errorMessage(error))}</span></div>`;
  }
}

export async function renderSearch() {
  const settings = state.settings ?? {};
  const warning =
    mapsConfigured() === false
      ? `<div class="notice notice-warning"><span><strong>Descoberta não configurada.</strong> A pesquisa real exige <span class="mono">APIFY_API_TOKEN</span> no servidor. Você pode preparar os filtros agora.</span></div>`
      : '';

  dom.main.innerHTML = `
    <div class="search-layout">
      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Nova prospecção</h2>
              <p>Informe nicho e localização. A origem de cada dado é registrada.</p>
            </div>
          </div>
          <div class="panel-body">
            ${warning}
            <form class="form-stack" data-form="search" novalidate style="margin-top:${warning ? '14px' : '0'}">
              <div class="form-grid">
                <label class="field field-full">
                  <span>Nicho ou segmento</span>
                  <input type="text" name="niche" required minlength="2" maxlength="100" placeholder="Ex.: clínica odontológica" value="${esc(settings.defaultNiche ?? '')}" autocomplete="off" />
                </label>
                <label class="field">
                  <span>Cidade</span>
                  <input type="text" name="city" required minlength="2" maxlength="100" placeholder="Ex.: Campinas" value="${esc(settings.defaultCity ?? '')}" autocomplete="address-level2" />
                </label>
                <label class="field">
                  <span>UF / Estado</span>
                  <input type="text" name="state" maxlength="100" placeholder="Ex.: SP" value="${esc(settings.defaultState ?? '')}" autocomplete="address-level1" />
                </label>
                <label class="field">
                  <span>País</span>
                  <input type="text" name="country" required maxlength="100" value="${esc(settings.defaultCountry ?? 'Brasil')}" autocomplete="country-name" />
                </label>
                <label class="field">
                  <span>Raio (km)</span>
                  <input type="number" name="radiusKm" min="1" max="50" step="1" placeholder="Opcional" />
                  <small class="hint">Quando informado, usa também o Geocoding (custo adicional).</small>
                </label>
                <label class="field">
                  <span>Limite de resultados</span>
                  <select name="limit">
                    ${Array.from({ length: 20 }, (_, index) => index + 1)
                      .map((value) =>
                        option(
                          value,
                          `${value} ${value === 1 ? 'empresa' : 'empresas'}`,
                          settings.defaultLimit ?? 20,
                        ),
                      )
                      .join('')}
                  </select>
                </label>
                <div class="field field-full">
                  <span class="hint">Cada pesquisa usa a Google Places API (New) e pode gerar cobrança conforme a tabela vigente do Google.</span>
                </div>
              </div>
              ${favoritesMarkup()}
              <p class="form-error" data-form-error role="alert" hidden></p>
              <div class="row">
                <button class="btn btn-primary" type="submit">Pesquisar empresas</button>
                <span class="small muted">Máximo de 20 resultados por pesquisa.</span>
              </div>
            </form>
          </div>
        </section>

        <section class="panel" id="search-status-panel" hidden>
          <div class="panel-head">
            <div>
              <h2>Andamento da pesquisa</h2>
              <p>Resultados salvos automaticamente no seu CRM.</p>
            </div>
            <button class="btn btn-ghost btn-icon" type="button" data-action="search-close-status" aria-label="Fechar painel">×</button>
          </div>
          <div class="panel-body" id="search-status-body"></div>
        </section>
      </div>

      <div class="stack">
        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Histórico</h2>
              <p>Últimas pesquisas realizadas.</p>
            </div>
          </div>
          <div class="panel-body">
            <div class="search-history" id="search-history-body">
              <div class="skeleton skeleton-line"></div>
              <div class="skeleton skeleton-line"></div>
              <div class="skeleton skeleton-line"></div>
            </div>
          </div>
        </section>

        <section class="panel">
          <div class="panel-head">
            <div>
              <h2>Como funciona</h2>
            </div>
          </div>
          <div class="panel-body">
            <div class="stack small muted">
              <p><strong class="small" style="color:var(--text)">1. Descoberta</strong><br>Empresas são buscadas no Google Maps via Apify pelo servidor, com base no nicho e localização.</p>
              <p><strong class="small" style="color:var(--text)">2. Enriquecimento</strong><br>Quando o lead tem site, canais publicados são lidos com proteção contra SSRF. Nada é inventado.</p>
              <p><strong class="small" style="color:var(--text)">3. Qualificação</strong><br>O score explica os pontos fortes e os problemas digitais encontrados.</p>
              <p><strong class="small" style="color:var(--text)">4. Acompanhamento</strong><br>Status, atividades e próximos passos ficam registrados no lead.</p>
            </div>
          </div>
        </section>
      </div>
    </div>`;

  updateSearchStatusPanel();
  if (state.activeSearch && !['completed', 'failed'].includes(state.activeSearch.status)) {
    startSearchPolling(state.activeSearch.id);
  }
  void loadSearchHistory();
}

export async function handleSearchSubmit(form) {
  clearFormMessages(form);
  const data = Object.fromEntries(new FormData(form).entries());
  if (!data.niche || !data.city) {
    showFormError(form, 'Informe o nicho e a cidade.');
    return;
  }
  setFormBusy(form, true, 'Pesquisando...');
  try {
    const response = await api('/api/searches', {
      method: 'POST',
      body: {
        niche: data.niche,
        city: data.city,
        state: data.state,
        country: data.country || 'Brasil',
        radiusKm: data.radiusKm || undefined,
        limit: Number(data.limit),
      },
    });
    state.activeSearch = response.search;
    state.activeStats = response.async ? null : response.stats;
    updateSearchStatusPanel();
    document.getElementById('search-status-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (response.search.status === 'completed' || response.search.status === 'failed') {
      if (response.search.status === 'completed') {
        toast(`Pesquisa concluída: ${fmtNumber(response.search.resultsCount)} lead(s).`, 'success');
      } else {
        toast(`Pesquisa falhou: ${response.search.errorMessage || 'erro desconhecido'}`, 'error');
      }
      void loadSearchHistory();
    } else {
      startSearchPolling(response.search.id);
      toast('Pesquisa iniciada. O enriquecimento roda em segundo plano.', 'info');
      void loadSearchHistory();
    }
  } catch (error) {
    showFormError(form, errorMessage(error));
  } finally {
    setFormBusy(form, false);
  }
}

function showLeadsForSearch(searchId) {
  state.leads.filters = { ...DEFAULT_FILTERS, searchId };
  state.leads.page = 1;
  state.leads.selected.clear();
  const target = '#/leads';
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export function handleSearchAction(element) {
  const action = element.dataset.action;
  if (action === 'search-fill-niche') {
    const input = document.querySelector('form[data-form="search"] input[name="niche"]');
    if (input) {
      input.value = element.dataset.niche ?? '';
      input.focus();
    }
    return true;
  }
  if (action === 'search-view-leads') {
    const id = state.activeSearch?.id;
    if (id) showLeadsForSearch(id);
    return true;
  }
  if (action === 'search-filter-leads') {
    const id = element.dataset.id;
    if (id) showLeadsForSearch(id);
    return true;
  }
  if (action === 'search-close-status') {
    stopSearchPolling();
    state.activeSearch = null;
    state.activeStats = null;
    updateSearchStatusPanel();
    return true;
  }
  if (action === 'search-dismiss') {
    stopSearchPolling();
    state.activeSearch = null;
    state.activeStats = null;
    updateSearchStatusPanel();
    const target = '#/search';
    if (window.location.hash !== target) window.location.hash = target;
    return true;
  }
  return false;
}
