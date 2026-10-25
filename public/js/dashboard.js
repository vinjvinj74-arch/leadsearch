import {
  ACTIVITY_LABELS,
  SEARCH_STATUS_LABELS,
  STATUS_LABELS,
  api,
  dom,
  emptyState,
  errorMessage,
  esc,
  fmtDate,
  fmtNumber,
  fmtRelative,
  mapsConfigured,
  pageSkeleton,
  state,
} from './core.js';

export async function renderDashboard() {
  dom.main.innerHTML = pageSkeleton('dashboard');
  try {
    const [dashboardResponse, searchesResponse] = await Promise.all([
      api('/api/dashboard'),
      api('/api/searches?limit=4').catch(() => null),
    ]);
    if (state.route !== 'dashboard') return;
    const dashboard = dashboardResponse.dashboard;
    const searches = searchesResponse?.searches ?? [];
    const totals = dashboard.totals;
    const maxFunnel = Math.max(1, ...dashboard.funnel.map((entry) => entry.count));
    const warning =
      mapsConfigured() === false
        ? `<div class="notice notice-warning"><span><strong>Google Maps não configurada.</strong> Defina <span class="mono">GOOGLE_MAPS_API_KEY</span> no servidor para executar pesquisas reais. <a href="#/settings">Abrir configurações</a></span></div>`
        : '';

    const upcoming = dashboard.upcoming.length
      ? dashboard.upcoming
          .map(
            (entry) => `
            <div class="history-item">
              <div>
                <strong>${esc(entry.leadName)}</strong>
                <small>${esc(entry.nextAction || entry.note || ACTIVITY_LABELS[entry.type] || entry.type)} · ${esc(fmtDate(entry.nextActionAt, true))}</small>
              </div>
              <button class="btn btn-sm" type="button" data-action="open-lead" data-id="${esc(entry.leadId)}">Abrir</button>
            </div>`,
          )
          .join('')
      : emptyState(
          'Nenhum próximo passo agendado',
          'Registre uma atividade com data de próximo passo ao abrir um lead.',
        );

    const recentSearches = searches.length
      ? searches
          .map(
            (search) => `
            <div class="history-item">
              <div>
                <strong>${esc(search.niche)}</strong>
                <small>${esc([search.city, search.state].filter(Boolean).join(' / '))} · ${esc(fmtRelative(search.createdAt))} · ${fmtNumber(search.resultsCount)} leads</small>
              </div>
              <div class="history-actions">
                <span class="status-badge">${esc(SEARCH_STATUS_LABELS[search.status] ?? search.status)}</span>
                ${
                  search.resultsCount > 0
                    ? `<button class="btn btn-sm" type="button" data-action="search-filter-leads" data-id="${esc(search.id)}">Leads</button>`
                    : ''
                }
              </div>
            </div>`,
          )
          .join('')
      : emptyState('Nenhuma pesquisa ainda', 'Execute sua primeira prospecção para começar.');

    dom.main.innerHTML = `
      <div class="stack">
        ${warning}
        <div class="stat-grid">
          <div class="stat-card">
            <div class="stat-label">Base de leads</div>
            <div class="stat-value">${fmtNumber(totals.total)}</div>
            <div class="stat-note">${fmtNumber(totals.enriched)} com site verificado</div>
          </div>
          <div class="stat-card stat-warning">
            <div class="stat-label">Oportunidades digitais</div>
            <div class="stat-value">${fmtNumber(totals.opportunities)}</div>
            <div class="stat-note">${fmtNumber(totals.withoutWebsite)} sem site cadastrado</div>
          </div>
          <div class="stat-card stat-accent">
            <div class="stat-label">Alta pontuação</div>
            <div class="stat-value">${fmtNumber(totals.qualified)}</div>
            <div class="stat-note">Score ≥ 70 e ainda ativos</div>
          </div>
          <div class="stat-card stat-success">
            <div class="stat-label">Conversão</div>
            <div class="stat-value">${dashboard.conversionRate === null ? '—' : `${dashboard.conversionRate}%`}</div>
            <div class="stat-note">${fmtNumber(totals.sales)} vendas / ${fmtNumber(totals.contacted)} contatados</div>
          </div>
        </div>

        <div class="grid-2">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Funil comercial</h2>
                <p>Distribuição atual dos leads por status.</p>
              </div>
              <span class="badge">${fmtNumber(totals.total)} leads</span>
            </div>
            <div class="panel-body">
              <div class="funnel">
                ${dashboard.funnel
                  .map((entry) => {
                    const width =
                      entry.count === 0 ? 0 : Math.max(3, Math.round((entry.count / maxFunnel) * 100));
                    return `
                      <div class="funnel-row">
                        <span class="funnel-label">${esc(STATUS_LABELS[entry.status] ?? entry.status)}</span>
                        <span class="funnel-bar"><span class="funnel-fill" style="width:${width}%"></span></span>
                        <span class="funnel-count">${fmtNumber(entry.count)}</span>
                      </div>`;
                  })
                  .join('')}
              </div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Próximos passos</h2>
                <p>Atividades com data agendada.</p>
              </div>
            </div>
            <div class="panel-body">
              <div class="search-history">${upcoming}</div>
            </div>
          </section>
        </div>

        <div class="grid-2">
          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Pesquisas recentes</h2>
                <p>Últimas prospecções executadas.</p>
              </div>
              <a class="btn btn-sm" href="#/search">Nova pesquisa</a>
            </div>
            <div class="panel-body">
              <div class="search-history">${recentSearches}</div>
            </div>
          </section>

          <section class="panel">
            <div class="panel-head">
              <div>
                <h2>Ações rápidas</h2>
                <p>Atalhos para o fluxo comercial.</p>
              </div>
            </div>
            <div class="panel-body">
              <div class="stack">
                <div class="notice notice-info">
                  <span>Priorize leads com <strong>score alto</strong> e <strong>site ausente ou com falha</strong>. A pontuação é explicável e pode ser revista em cada lead.</span>
                </div>
                <div class="action-row">
                  <a class="btn btn-primary" href="#/search">Prospectar empresas</a>
                  <a class="btn" href="#/leads">Revisar leads</a>
                  <a class="btn btn-ghost" href="#/settings">Configurar integrações</a>
                </div>
                <div class="row-between small muted">
                  <span>Contatados: ${fmtNumber(totals.contacted)}</span>
                  <span>Responderam: ${fmtNumber(totals.responded)}</span>
                  <span>Propostas: ${fmtNumber(totals.proposals)}</span>
                </div>
              </div>
            </div>
          </section>
        </div>
      </div>`;
  } catch (error) {
    if (state.route !== 'dashboard') return;
    dom.main.innerHTML = `
      <section class="panel">
        <div class="panel-body">
          ${emptyState(
            'Não foi possível carregar o dashboard',
            errorMessage(error),
            '<button class="btn" type="button" data-action="retry-route">Tentar novamente</button>',
          )}
        </div>
      </section>`;
  }
}
