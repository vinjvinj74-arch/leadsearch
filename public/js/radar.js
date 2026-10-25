import {
  LEAD_STATUSES,
  STATUS_LABELS,
  WEBSITE_LABELS,
  WEBSITE_STATUSES,
  api,
  closeModal,
  dom,
  errorMessage,
  esc,
  externalLink,
  fmtDate,
  fmtNumber,
  fmtRelative,
  hostname,
  openModalShell,
  option,
  scorePill,
  state,
  statusBadge,
  toast,
  websiteBadge,
} from './core.js';
import { openLead } from './leadDetail.js';

const RADAR_STATUS_LABELS = {
  pending: 'Na fila',
  running: 'Pesquisando empresas',
  completed: 'Concluída',
  failed: 'Falhou',
  cancelled: 'Cancelada',
};

const RADAR_STATUS_CLASS = {
  pending: 'badge',
  running: 'badge badge-accent',
  completed: 'badge badge-success',
  failed: 'badge badge-danger',
  cancelled: 'badge badge-warning',
};

const ACTIVE_STATUSES = new Set(['pending', 'running']);
const MAX_RESULTS = 5;

const TILE_PROVIDER = {
  url: 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener noreferrer">OpenStreetMap</a> contributors',
  maxZoom: 19,
};

const CONTACTED_STATUSES = new Set([
  'contatado',
  'aguardando_resposta',
  'respondeu',
  'reuniao_agendada',
  'proposta_enviada',
  'em_negociacao',
]);

const CLOSED_STATUSES = new Set(['vendido', 'perdido']);

function defaultFilters() {
  return {
    segments: [],
    keyword: '',
    companyName: '',
    includeKeywords: [],
    excludeKeywords: [],
    website: 'all',
    minRating: null,
    minReviews: null,
    activeOnly: true,
    phonePresence: 'any',
    hasAddress: 'any',
    noEmail: false,
    incompleteContact: false,
    siteStatus: null,
    minScore: null,
    maxScore: null,
    crmState: 'all',
    crmStatus: null,
    updatedDays: null,
    visibleArea: false,
    sort: 'score',
  };
}

const radar = {
  userId: null,
  search: null,
  results: [],
  history: null,
  filters: defaultFilters(),
  location: null,
  query: '',
  country: 'Brasil',
  radiusKm: null,
  limit: MAX_RESULTS,
  centerMap: true,
  suggestions: [],
  suggestionsOpen: false,
  suggestionLoading: false,
  suggestionError: null,
  suggestionSeq: 0,
  locationTimer: null,
  filterTimer: null,
  loadSeq: 0,
  historySeq: 0,
  map: null,
  cluster: null,
  markers: new Map(),
  areaLayer: null,
  selected: new Set(),
  selectedId: null,
  timer: null,
  pollBusy: false,
  moveTimer: null,
  pendingConfirm: null,
  confirmBusy: false,
  submitting: false,
};

function normalize(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function splitList(value) {
  return String(value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function numberOrNull(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const parsed = Number(text.replace(',', '.'));
  return Number.isFinite(parsed) ? parsed : null;
}

function integerOrNull(value) {
  const parsed = numberOrNull(value);
  return parsed === null ? null : Math.trunc(parsed);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function hasCoordinates(item) {
  return (
    Number.isFinite(Number(item.latitude)) &&
    Number.isFinite(Number(item.longitude)) &&
    Number(item.latitude) >= -90 &&
    Number(item.latitude) <= 90 &&
    Number(item.longitude) >= -180 &&
    Number(item.longitude) <= 180
  );
}

function isActive() {
  return Boolean(radar.search && ACTIVE_STATUSES.has(radar.search.status));
}

function activeLabel() {
  return RADAR_STATUS_LABELS[radar.search?.status] ?? 'Radar';
}

function filterSegmentsText() {
  return radar.filters.segments.join(', ');
}

function filterValue(value) {
  return value === null || value === undefined ? '' : String(value);
}

function filterCheckbox(value) {
  return value ? 'checked' : '';
}

function selectedOption(value, current) {
  return String(value ?? '') === String(current ?? '') ? ' selected' : '';
}

function countryDisplay(code) {
  const normalized = String(code ?? '').toLowerCase();
  if (normalized === 'br' || normalized === 'brasil') return 'Brasil';
  if (normalized === 'pt' || normalized === 'portugal') return 'Portugal';
  if (normalized === 'us' || normalized === 'usa' || normalized === 'estados unidos') return 'Estados Unidos';
  return code ? String(code).toUpperCase() : 'Brasil';
}

function recommendedName() {
  if (!radar.search) return '';
  const parts = radar.filters.segments.slice(0, 2).join(' + ');
  const subject = radar.filters.companyName || parts || radar.filters.keyword || 'Empresas';
  const place = (radar.location?.label || radar.search.location.label || '').split(',')[0];
  return `${subject}${place ? ` em ${place}` : ''}`.slice(0, 160);
}

function filtersMerge(filters) {
  const base = defaultFilters();
  if (!filters || typeof filters !== 'object') return base;
  return {
    ...base,
    ...filters,
    segments: Array.isArray(filters.segments) ? filters.segments : base.segments,
    includeKeywords: Array.isArray(filters.includeKeywords) ? filters.includeKeywords : base.includeKeywords,
    excludeKeywords: Array.isArray(filters.excludeKeywords) ? filters.excludeKeywords : base.excludeKeywords,
    activeOnly: filters.activeOnly !== false,
    noEmail: filters.noEmail === true,
    incompleteContact: filters.incompleteContact === true,
    visibleArea: filters.visibleArea === true,
  };
}

function applySearchParams(data) {
  const search = data.search;
  radar.search = search;
  radar.results = Array.isArray(data.results) ? data.results : [];
  radar.filters = filtersMerge(search.filters);
  radar.query = search.location.query || search.location.label || '';
  radar.limit = clamp(Number(search.resultLimit) || MAX_RESULTS, 1, MAX_RESULTS);
  radar.radiusKm = search.radiusKm === null || search.radiusKm === undefined ? null : Number(search.radiusKm);
  radar.country = countryDisplay(search.location.countryCode);
  radar.location =
    Number.isFinite(Number(search.location.latitude)) && Number.isFinite(Number(search.location.longitude))
      ? {
          id: 'saved',
          label: search.location.label || search.location.query || 'Local da pesquisa',
          latitude: Number(search.location.latitude),
          longitude: Number(search.location.longitude),
          countryCode: search.location.countryCode,
          country: null,
          city: null,
          state: null,
          neighborhood: null,
          postalCode: null,
          boundingBox: null,
        }
      : null;
  radar.selectedId = null;
  radar.selected.clear();
}

function applyRefreshedSearch(data) {
  radar.search = data.search;
  radar.results = Array.isArray(data.results) ? data.results : [];
}

function clearSearchState({ clearFilters = false } = {}) {
  radar.search = null;
  radar.results = [];
  radar.selectedId = null;
  radar.selected.clear();
  radar.suggestions = [];
  radar.suggestionsOpen = false;
  radar.suggestionSeq += 1;
  if (radar.locationTimer) {
    window.clearTimeout(radar.locationTimer);
    radar.locationTimer = null;
  }
  if (radar.filterTimer) {
    window.clearTimeout(radar.filterTimer);
    radar.filterTimer = null;
  }
  if (radar.moveTimer) {
    window.clearTimeout(radar.moveTimer);
    radar.moveTimer = null;
  }
  stopRadarPolling();
  if (clearFilters) {
    radar.filters = defaultFilters();
    radar.location = null;
    radar.query = '';
    radar.country = 'Brasil';
    radar.radiusKm = null;
    radar.limit = MAX_RESULTS;
  }
}

function activeFilterLabels(filters) {
  const labels = [];
  if (filters.segments.length) labels.push(`Segmentos: ${filters.segments.join(', ')}`);
  if (filters.companyName) labels.push(`Empresa: ${filters.companyName}`);
  if (filters.keyword) labels.push(`Nicho: ${filters.keyword}`);
  if (filters.includeKeywords.length) labels.push(`Inclui: ${filters.includeKeywords.join(', ')}`);
  if (filters.excludeKeywords.length) labels.push(`Exclui: ${filters.excludeKeywords.join(', ')}`);
  if (filters.website === 'with') labels.push('Com site cadastrado');
  if (filters.website === 'without') labels.push('Sem site cadastrado');
  if (filters.minRating !== null) labels.push(`Nota ≥ ${filters.minRating}`);
  if (filters.minReviews !== null) labels.push(`Avaliações ≥ ${filters.minReviews}`);
  if (!filters.activeOnly) labels.push('Inclui locais fechados');
  if (filters.phonePresence === 'with') labels.push('Com telefone');
  if (filters.phonePresence === 'without') labels.push('Sem telefone');
  if (filters.hasAddress === 'with') labels.push('Com endereço');
  if (filters.hasAddress === 'without') labels.push('Sem endereço');
  if (filters.noEmail) labels.push('Sem e-mail');
  if (filters.incompleteContact) labels.push('Contato incompleto');
  if (filters.siteStatus) labels.push(`Site: ${WEBSITE_LABELS[filters.siteStatus] ?? filters.siteStatus}`);
  if (filters.minScore !== null) labels.push(`Score ≥ ${filters.minScore}`);
  if (filters.maxScore !== null) labels.push(`Score ≤ ${filters.maxScore}`);
  if (filters.crmState !== 'all') {
    const crmLabels = {
      unsaved: 'Fora do CRM',
      saved: 'No CRM',
      not_contacted: 'Ainda não contatadas',
      contacted: 'Já abordadas',
      closed: 'Vendidas ou perdidas',
    };
    labels.push(crmLabels[filters.crmState]);
  }
  if (filters.crmStatus) labels.push(`Status: ${STATUS_LABELS[filters.crmStatus] ?? filters.crmStatus}`);
  if (filters.updatedDays !== null) labels.push(`Atualizado em ${filters.updatedDays}d`);
  if (filters.visibleArea) labels.push('Somente área visível');
  if (filters.sort !== 'score') {
    const sortLabels = {
      name: 'Nome',
      rating: 'Nota',
      reviews: 'Avaliações',
      recent: 'Mais recentes',
    };
    labels.push(`Ordem: ${sortLabels[filters.sort] ?? filters.sort}`);
  }
  return labels;
}

function updateFilterSummary() {
  const target = document.getElementById('radar-active-filters');
  const count = document.getElementById('radar-filter-count');
  const labels = activeFilterLabels(radar.filters);
  if (count) count.textContent = labels.length ? `${labels.length} ativo(s)` : 'Sem filtros ativos';
  if (!target) return;
  target.innerHTML = labels.length
    ? labels.map((label) => `<span class="badge radar-filter-chip">${esc(label)}</span>`).join('')
    : '<span class="small muted">Nenhum filtro adicional ativo.</span>';
}

function formError(message) {
  const element = document.querySelector('[data-radar-form-error]');
  if (!element) {
    if (message) toast(message, 'error');
    return;
  }
  element.textContent = message;
  element.hidden = !message;
}

function readFiltersFromForm() {
  const form = document.getElementById('radar-filters-form');
  if (!(form instanceof HTMLFormElement)) return;
  const data = new FormData(form);
  const text = (name) => String(data.get(name) ?? '').trim();
  radar.filters = {
    segments: splitList(text('segments')).slice(0, 5),
    keyword: text('keyword'),
    companyName: text('companyName'),
    includeKeywords: splitList(text('includeKeywords')).slice(0, 20),
    excludeKeywords: splitList(text('excludeKeywords')).slice(0, 20),
    website: text('website') || 'all',
    minRating: numberOrNull(text('minRating')),
    minReviews: integerOrNull(text('minReviews')),
    activeOnly: data.has('activeOnly'),
    phonePresence: text('phonePresence') || 'any',
    hasAddress: text('hasAddress') || 'any',
    noEmail: data.has('noEmail'),
    incompleteContact: data.has('incompleteContact'),
    siteStatus: text('siteStatus') || null,
    minScore: integerOrNull(text('minScore')),
    maxScore: integerOrNull(text('maxScore')),
    crmState: text('crmState') || 'all',
    crmStatus: text('crmStatus') || null,
    updatedDays: integerOrNull(text('updatedDays')),
    visibleArea: data.has('visibleArea'),
    sort: text('sort') || 'score',
  };
  const country = text('country');
  if (country) radar.country = country;
  radar.radiusKm = integerOrNull(text('radius'));
  radar.limit = clamp(integerOrNull(text('limit')) ?? MAX_RESULTS, 1, MAX_RESULTS);
  radar.centerMap = data.has('centerMap');
}

function validateForm() {
  if (!radar.location) {
    formError('Digite uma localidade e selecione uma sugestão válida da lista.');
    document.getElementById('radar-location-input')?.focus();
    return false;
  }
  if (!radar.filters.segments.length && !radar.filters.companyName && !radar.filters.keyword) {
    formError('Informe ao menos um segmento, nicho, palavra-chave ou nome de empresa.');
    document.getElementById('radar-segments')?.focus();
    return false;
  }
  if (
    radar.filters.minScore !== null &&
    radar.filters.maxScore !== null &&
    radar.filters.minScore > radar.filters.maxScore
  ) {
    formError('A pontuação mínima não pode ser maior que a pontuação máxima.');
    return false;
  }
  if (radar.filters.segments.length > 5) {
    formError('Use no máximo 5 segmentos por pesquisa.');
    return false;
  }
  if (radar.radiusKm !== null && (radar.radiusKm < 1 || radar.radiusKm > 50)) {
    formError('O raio deve ficar entre 1 e 50 km.');
    return false;
  }
  formError('');
  return true;
}

function locationSelectedMarkup() {
  const location = radar.location;
  if (!location) {
    return '<p class="small muted">Nenhuma localização selecionada. A pesquisa geográfica exige uma sugestão válida.</p>';
  }
  const details = [
    location.neighborhood,
    location.city,
    location.state,
    location.postalCode,
    location.country ?? countryDisplay(location.countryCode),
  ].filter(Boolean);
  return `
    <div class="radar-location-card">
      <span class="radar-location-pin" aria-hidden="true"></span>
      <div>
        <strong>${esc(location.label)}</strong>
        <small>${esc([...new Set(details)].join(' · ') || 'Coordenadas validadas')}</small>
      </div>
      <span class="badge badge-success">Selecionada</span>
    </div>`;
}

function updateLocationSelected() {
  const target = document.getElementById('radar-location-selected');
  if (target) target.innerHTML = locationSelectedMarkup();
}

function updateLocationSuggestions() {
  const container = document.getElementById('radar-location-suggestions');
  const input = document.getElementById('radar-location-input');
  if (!container || !input) return;
  input.setAttribute('aria-expanded', radar.suggestionsOpen ? 'true' : 'false');
  if (!radar.suggestionsOpen) {
    container.hidden = true;
    container.innerHTML = '';
    return;
  }
  container.hidden = false;
  if (radar.suggestionLoading) {
    container.innerHTML =
      '<div class="radar-location-message"><span class="spinner" aria-hidden="true"></span> Consultando localidades...</div>';
    return;
  }
  if (radar.suggestionError) {
    container.innerHTML = `<div class="radar-location-message">${esc(radar.suggestionError)}</div>`;
    return;
  }
  if (!radar.suggestions.length) {
    container.innerHTML =
      '<div class="radar-location-message">Nenhuma localidade encontrada. Tente cidade, estado e país.</div>';
    return;
  }
  container.innerHTML = radar.suggestions
    .map((location, index) => {
      const details = [location.city, location.state, location.country].filter(Boolean);
      return `
        <button class="radar-location-option" type="button" role="option" data-action="radar-pick-location" data-index="${index}">
          <span class="radar-location-pin" aria-hidden="true"></span>
          <span>
            <strong>${esc(location.label)}</strong>
            <small>${esc([...new Set(details)].join(' · ') || 'Localidade')}</small>
          </span>
        </button>`;
    })
    .join('');
}

async function searchLocationSuggestions() {
  const sequence = ++radar.suggestionSeq;
  const query = radar.query.trim();
  if (query.length < 3) {
    radar.suggestions = [];
    radar.suggestionsOpen = false;
    radar.suggestionLoading = false;
    radar.suggestionError = null;
    updateLocationSuggestions();
    return;
  }
  radar.suggestionLoading = true;
  radar.suggestionError = null;
  radar.suggestionsOpen = true;
  updateLocationSuggestions();
  try {
    const params = new URLSearchParams({ q: query });
    if (radar.country.trim()) params.set('country', radar.country.trim());
    const data = await api(`/api/radar/locations?${params.toString()}`);
    if (sequence !== radar.suggestionSeq || state.route !== 'radar') return;
    radar.suggestions = Array.isArray(data.locations) ? data.locations : [];
  } catch (error) {
    if (sequence !== radar.suggestionSeq || state.route !== 'radar') return;
    radar.suggestions = [];
    radar.suggestionError = errorMessage(error);
  } finally {
    if (sequence === radar.suggestionSeq) {
      radar.suggestionLoading = false;
      updateLocationSuggestions();
    }
  }
}

function scheduleLocationSearch() {
  if (radar.locationTimer) window.clearTimeout(radar.locationTimer);
  radar.locationTimer = window.setTimeout(() => {
    radar.locationTimer = null;
    void searchLocationSuggestions();
  }, 420);
}

function pickLocation(index) {
  const location = radar.suggestions[index];
  if (!location) return;
  radar.location = location;
  radar.query = location.label;
  radar.suggestionsOpen = false;
  radar.suggestions = [];
  const input = document.getElementById('radar-location-input');
  if (input) {
    input.value = location.label;
    input.setAttribute('aria-expanded', 'false');
  }
  updateLocationSelected();
  updateLocationSuggestions();
  formError('');
  if (radar.centerMap) centerMapOnSearch(location, true);
  drawAreaCircle();
}

function markerIcon(score, selected) {
  const value = Math.round(Number(score ?? 0));
  const tone = value >= 70 ? 'high' : value >= 40 ? 'mid' : 'low';
  return window.L.divIcon({
    className: `radar-marker ${selected ? 'is-selected' : ''}`,
    html: `<span class="radar-marker-dot radar-marker-${tone}">${value}</span>`,
    iconSize: [34, 34],
    iconAnchor: [17, 17],
    popupAnchor: [0, -18],
  });
}

function initMap() {
  const container = document.getElementById('radar-map');
  if (!container) return;
  if (!window.L) {
    container.innerHTML =
      '<div class="radar-map-failure">Não foi possível carregar o mapa. Recarregue a página.</div>';
    return;
  }
  disposeMap();
  const map = window.L.map(container, {
    zoomControl: true,
    attributionControl: true,
    worldCopyJump: true,
    minZoom: 3,
  }).setView([-14.235, -51.9253], 4);

  window.L.tileLayer(TILE_PROVIDER.url, {
    attribution: TILE_PROVIDER.attribution,
    maxZoom: TILE_PROVIDER.maxZoom,
    subdomains: 'abc',
  }).addTo(map);

  radar.cluster = window.L.markerClusterGroup({
    maxClusterRadius: 46,
    showCoverageOnHover: false,
    spiderfyOnMaxZoom: true,
    disableClusteringAtZoom: 17,
  });
  map.addLayer(radar.cluster);
  radar.map = map;

  map.on('moveend zoomend', () => {
    if (radar.moveTimer) window.clearTimeout(radar.moveTimer);
    radar.moveTimer = window.setTimeout(() => {
      radar.moveTimer = null;
      if (state.route === 'radar' && radar.filters.visibleArea) renderResults();
    }, 220);
  });

  centerMapOnSearch(radar.location, true);
  drawAreaCircle();
  window.setTimeout(() => map.invalidateSize(), 80);
}

function disposeMap() {
  if (radar.map) {
    radar.map.remove();
    radar.map = null;
  }
  radar.cluster = null;
  radar.markers.clear();
  radar.areaLayer = null;
}

function centerMapOnSearch(location, fitBounds = true) {
  if (!radar.map || !location) return;
  const latitude = Number(location.latitude);
  const longitude = Number(location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  const box = location.boundingBox;
  if (
    fitBounds &&
    box &&
    [box.south, box.north, box.west, box.east].every((value) => Number.isFinite(Number(value)))
  ) {
    radar.map.fitBounds(
      [
        [Number(box.south), Number(box.west)],
        [Number(box.north), Number(box.east)],
      ],
      { padding: [28, 28], maxZoom: 14 },
    );
  } else {
    radar.map.setView([latitude, longitude], radar.radiusKm ? 12 : 13);
  }
}

function drawAreaCircle() {
  if (!radar.map) return;
  if (radar.areaLayer) {
    radar.map.removeLayer(radar.areaLayer);
    radar.areaLayer = null;
  }
  if (!radar.location || !radar.radiusKm) return;
  const latitude = Number(radar.location.latitude);
  const longitude = Number(radar.location.longitude);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return;
  radar.areaLayer = window.L.circle([latitude, longitude], {
    radius: radar.radiusKm * 1000,
    color: '#6f93ff',
    weight: 1.5,
    fillColor: '#6f93ff',
    fillOpacity: 0.08,
  }).addTo(radar.map);
}

function buildResultPopup(result) {
  const address = [result.address, result.city, result.state].filter(Boolean).join(' · ');
  return `
    <div class="radar-popup">
      <div class="row-between">
        <strong>${esc(result.name)}</strong>
        ${scorePill(result.score)}
      </div>
      <small>${esc(result.category || 'Categoria não informada')}</small>
      ${address ? `<span>${esc(address)}</span>` : ''}
      <div class="row radar-popup-actions">
        <button class="btn btn-sm btn-primary" type="button" data-action="radar-detail" data-id="${esc(result.id)}">Ver detalhes</button>
        ${result.latitude !== null && result.longitude !== null ? '<span class="small muted">Selecionado no mapa</span>' : '<span class="small muted">Sem coordenadas</span>'}
      </div>
    </div>`;
}

function renderMarkers(rows) {
  if (!radar.map || !radar.cluster) return;
  radar.cluster.clearLayers();
  radar.markers.clear();
  const points = [];
  for (const result of rows) {
    if (!hasCoordinates(result)) continue;
    const latitude = Number(result.latitude);
    const longitude = Number(result.longitude);
    const marker = window.L.marker([latitude, longitude], {
      icon: markerIcon(result.score, radar.selectedId === result.id),
      title: result.name,
      keyboard: true,
    });
    marker.bindPopup(buildResultPopup(result), { maxWidth: 280, minWidth: 230 });
    marker.on('click', () => selectResult(result.id, { fromMap: true, openPopup: false }));
    radar.cluster.addLayer(marker);
    radar.markers.set(result.id, marker);
    points.push([latitude, longitude]);
  }
  updateMapOverlay(rows);
  if (radar.selectedId) updateMarkerSelection();
  return points;
}

function fitResults(rows) {
  if (!radar.map) return;
  const points = rows
    .filter(hasCoordinates)
    .map((result) => [Number(result.latitude), Number(result.longitude)]);
  if (!points.length) {
    centerMapOnSearch(radar.location, false);
    return;
  }
  if (points.length === 1) {
    radar.map.setView(points[0], 15);
    return;
  }
  radar.map.fitBounds(points, { padding: [38, 38], maxZoom: 15 });
}

function resultMatches(result, filters, mapBounds) {
  if (filters.website === 'with' && !result.website) return false;
  if (filters.website === 'without' && result.website) return false;
  if (filters.minRating !== null && (result.rating === null || Number(result.rating) < filters.minRating)) {
    return false;
  }
  if (
    filters.minReviews !== null &&
    (result.reviewsCount === null || Number(result.reviewsCount) < filters.minReviews)
  ) {
    return false;
  }
  if (filters.activeOnly && result.businessStatus && String(result.businessStatus).includes('CLOSED')) {
    return false;
  }
  if (filters.phonePresence === 'with' && !result.phone) return false;
  if (filters.phonePresence === 'without' && result.phone) return false;
  if (filters.hasAddress === 'with' && !result.address && !result.city) return false;
  if (filters.hasAddress === 'without' && (result.address || result.city)) return false;
  if (filters.noEmail && result.email) return false;
  if (filters.incompleteContact && result.phone && result.website && result.email) return false;
  if (filters.siteStatus) {
    const status = result.websiteStatus || 'unknown';
    if (status !== filters.siteStatus) return false;
  }
  if (filters.minScore !== null && Number(result.score) < filters.minScore) return false;
  if (filters.maxScore !== null && Number(result.score) > filters.maxScore) return false;
  if (filters.crmState === 'unsaved' && result.saved) return false;
  if (filters.crmState === 'saved' && !result.saved) return false;
  if (filters.crmState === 'not_contacted') {
    if (!result.saved || result.doNotContact) return false;
    if (!['novo', 'qualificado'].includes(result.crmStatus)) return false;
  }
  if (filters.crmState === 'contacted') {
    if (!result.saved || result.doNotContact) return false;
    if (!CONTACTED_STATUSES.has(result.crmStatus)) return false;
  }
  if (filters.crmState === 'closed') {
    if (!result.saved) return false;
    if (!CLOSED_STATUSES.has(result.crmStatus)) return false;
  }
  if (filters.crmStatus && result.crmStatus !== filters.crmStatus) return false;
  if (filters.updatedDays !== null) {
    const updated = new Date(result.updatedAt || result.createdAt);
    if (Number.isNaN(updated.getTime())) return false;
    const ageDays = (Date.now() - updated.getTime()) / 86_400_000;
    if (ageDays > filters.updatedDays) return false;
  }
  if (filters.visibleArea && mapBounds) {
    if (!hasCoordinates(result)) return false;
    if (!mapBounds.contains([Number(result.latitude), Number(result.longitude)])) return false;
  }

  const haystack = normalize(
    [result.name, result.category, result.address, result.city, result.state].filter(Boolean).join(' '),
  );
  if (filters.includeKeywords.length) {
    if (!filters.includeKeywords.every((word) => haystack.includes(normalize(word)))) return false;
  }
  if (filters.excludeKeywords.length) {
    if (filters.excludeKeywords.some((word) => haystack.includes(normalize(word)))) return false;
  }
  return true;
}

function filteredResults() {
  const filters = radar.filters;
  const mapBounds = filters.visibleArea && radar.map ? radar.map.getBounds() : null;
  const rows = radar.results.filter((result) => resultMatches(result, filters, mapBounds));
  rows.sort((a, b) => {
    if (filters.sort === 'name') return a.name.localeCompare(b.name, 'pt-BR');
    if (filters.sort === 'rating') return Number(b.rating ?? -1) - Number(a.rating ?? -1);
    if (filters.sort === 'reviews') return Number(b.reviewsCount ?? -1) - Number(a.reviewsCount ?? -1);
    if (filters.sort === 'recent') {
      return new Date(b.updatedAt || b.createdAt).getTime() - new Date(a.updatedAt || a.createdAt).getTime();
    }
    return Number(b.score ?? 0) - Number(a.score ?? 0);
  });
  return rows;
}

function updateSearchChrome() {
  const target = document.getElementById('radar-map-head');
  if (!target) return;
  const search = radar.search;
  const canUseSearch = Boolean(search);
  const isSaved = Boolean(search?.isSaved);
  target.innerHTML = `
    <div class="radar-map-title">
      <div class="row">
        <h2>${esc(search?.name || 'Mapa de oportunidades')}</h2>
        ${search ? `<span class="${RADAR_STATUS_CLASS[search.status] ?? 'badge'}">${esc(RADAR_STATUS_LABELS[search.status] ?? search.status)}</span>` : ''}
        ${isSaved ? '<span class="badge badge-success">Pesquisa salva</span>' : ''}
      </div>
      <p>${esc(search ? [search.location.label, search.radiusKm ? `${search.radiusKm} km` : null, `${search.resultLimit} resultados no máximo`].filter(Boolean).join(' · ') : 'Use os filtros para preparar uma pesquisa geográfica.')}</p>
    </div>
    <div class="radar-map-actions">
      <button class="btn btn-sm radar-mobile-filter" type="button" data-action="radar-filters-toggle">Filtros</button>
      <button class="btn btn-sm" type="button" data-action="radar-fit" ${radar.results.some(hasCoordinates) ? '' : 'disabled'}>Enquadrar</button>
      <button class="btn btn-sm" type="button" data-action="radar-save-search" ${canUseSearch && !isSaved ? '' : 'disabled'}>Salvar pesquisa</button>
      <button class="btn btn-sm btn-ghost" type="button" data-action="radar-new" ${canUseSearch ? '' : 'disabled'}>Nova pesquisa</button>
    </div>`;
}

function statusNoticeMarkup() {
  const search = radar.search;
  if (!search) {
    return `
      <div class="notice notice-info">
        <span><strong>Pronto para o Radar.</strong> A pesquisa só começa após revisar e confirmar os parâmetros. Nenhuma pesquisa é feita ao abrir esta página.</span>
      </div>`;
  }
  if (isActive()) {
    return `
      <div class="radar-search-progress">
        <div class="row-between">
          <div class="row">
            <span class="spinner" aria-hidden="true"></span>
            <div>
              <strong>${esc(activeLabel())}</strong>
              <p class="small muted">A pesquisa continua no servidor. Você pode navegar para outra área; o resultado fica no histórico.</p>
            </div>
          </div>
          <button class="btn btn-sm btn-danger-ghost" type="button" data-action="radar-cancel">Cancelar pesquisa</button>
        </div>
        <div class="radar-progress-track"><span></span></div>
      </div>`;
  }
  if (search.status === 'completed') {
    const saved = radar.results.filter((result) => result.saved).length;
    return `
      <div class="notice notice-success">
        <span><strong>Pesquisa concluída.</strong> ${fmtNumber(search.resultsCount)} empresa(s) encontrada(s), ${fmtNumber(saved)} salva(s) no CRM. Dados de ${esc(fmtDate(search.completedAt || search.updatedAt, true))}.</span>
      </div>`;
  }
  if (search.status === 'failed') {
    return `
      <div class="notice notice-danger">
        <span><strong>A pesquisa falhou.</strong> ${esc(search.errorMessage || 'Não foi possível concluir a pesquisa. Revise os parâmetros e tente novamente.')}</span>
        <button class="btn btn-sm" type="button" data-action="radar-rerun">Revisar e repetir</button>
      </div>`;
  }
  if (search.status === 'cancelled') {
    return `
      <div class="notice notice-warning">
        <span><strong>Pesquisa cancelada.</strong> Os resultados parciais podem não ter sido importados. Nenhuma nova pesquisa é iniciada automaticamente.</span>
        <button class="btn btn-sm" type="button" data-action="radar-rerun">Revisar e repetir</button>
      </div>`;
  }
  return '';
}

function updateSearchStatus() {
  const target = document.getElementById('radar-search-status');
  if (target) target.innerHTML = statusNoticeMarkup();
  updateSearchChrome();
}

function resultWebsiteMarkup(result) {
  if (!result.website) return '<span class="badge">Sem site cadastrado</span>';
  const label = hostname(result.website) || 'Site cadastrado';
  const link = externalLink(result.website, label, 'class="radar-result-link"');
  return `${link}<span class="radar-result-presence">${result.websiteStatus ? websiteBadge(result.websiteStatus) : '<span class="badge badge-accent">Site cadastrado</span>'}</span>`;
}

function resultCrmMarkup(result) {
  if (!result.saved) return '<span class="badge">Fora do CRM</span>';
  return `
    ${result.crmStatus ? statusBadge(result.crmStatus) : '<span class="badge badge-success">No CRM</span>'}
    ${result.doNotContact ? '<span class="badge badge-danger">Não contatar</span>' : ''}`;
}

function resultRowMarkup(result) {
  const checked = radar.selected.has(result.id) ? 'checked' : '';
  const selected = radar.selectedId === result.id ? ' is-selected' : '';
  const address = [result.address, result.city, result.state].filter(Boolean).join(' · ');
  const rating =
    result.rating !== null
      ? `<span class="radar-rating">★ ${esc(Number(result.rating).toFixed(1))}</span><span class="small muted">(${fmtNumber(result.reviewsCount ?? 0)})</span>`
      : '<span class="small muted">Sem avaliação</span>';
  return `
    <div class="radar-result${selected}" data-radar-result="${esc(result.id)}">
      <div class="radar-result-check">
        <input type="checkbox" data-radar-check value="${esc(result.id)}" aria-label="Selecionar ${esc(result.name)}" ${checked} />
      </div>
      <div class="radar-result-main" data-action="radar-select" data-id="${esc(result.id)}" tabindex="0" role="button" aria-label="Selecionar ${esc(result.name)} no mapa">
        <div class="radar-result-head">
          <div>
            <strong>${esc(result.name)}</strong>
            <small>${esc(result.category || 'Categoria não informada')}</small>
          </div>
          <div class="row">${scorePill(result.score)}</div>
        </div>
        <div class="radar-result-meta">
          ${rating}
          ${hasCoordinates(result) ? '<span class="badge badge-accent">No mapa</span>' : '<span class="badge badge-warning">Sem coordenadas</span>'}
          ${result.distanceLabel ? `<span class="small muted">${esc(result.distanceLabel)}</span>` : ''}
        </div>
        ${address ? `<p class="radar-result-address">${esc(address)}</p>` : '<p class="radar-result-address muted">Endereço não informado</p>'}
        <div class="radar-result-contact">
          <span>${result.phone ? esc(result.phone) : '<span class="muted">Sem telefone</span>'}</span>
          <span>${resultWebsiteMarkup(result)}</span>
        </div>
        <div class="radar-result-foot">
          <div class="row">${resultCrmMarkup(result)}</div>
          <div class="row">
            <button class="btn btn-sm btn-ghost" type="button" data-action="radar-detail" data-id="${esc(result.id)}">Detalhes</button>
            <button class="btn btn-sm" type="button" data-action="radar-select" data-id="${esc(result.id)}">No mapa</button>
            ${
              result.saved
                ? `<button class="btn btn-sm btn-ghost" type="button" data-action="radar-open-lead" data-id="${esc(result.leadId)}">Abrir CRM</button>`
                : `<button class="btn btn-sm btn-primary" type="button" data-action="radar-save-result" data-id="${esc(result.id)}">Salvar no CRM</button>`
            }
          </div>
        </div>
      </div>
    </div>`;
}

function resultsEmptyMarkup(rows) {
  if (!radar.search) {
    return `
      <div class="radar-empty">
        <span class="radar-empty-icon" aria-hidden="true"></span>
        <strong>Pronto para encontrar oportunidades?</strong>
        <p>Escolha a localização, os segmentos e revise a pesquisa. Os resultados aparecerão no mapa e nesta lista.</p>
      </div>`;
  }
  if (isActive()) {
    return `
      <div class="radar-empty">
        <span class="spinner" aria-hidden="true"></span>
        <strong>${esc(activeLabel())}</strong>
        <p>A lista será preenchida quando a pesquisa terminar. Não é necessário manter esta página aberta.</p>
      </div>`;
  }
  if (radar.search.status === 'failed' || radar.search.status === 'cancelled') {
    return `
      <div class="radar-empty">
        <span class="radar-empty-icon" aria-hidden="true"></span>
        <strong>Sem resultados para exibir</strong>
        <p>${esc(radar.search.errorMessage || 'A última pesquisa não foi concluída.')}</p>
        <button class="btn" type="button" data-action="radar-rerun">Revisar e repetir</button>
      </div>`;
  }
  if (!radar.results.length) {
    return `
      <div class="radar-empty">
        <span class="radar-empty-icon" aria-hidden="true"></span>
        <strong>Nenhuma empresa encontrada</strong>
        <p>A pesquisa não retornou empresas para estes parâmetros. Tente ampliar o raio, remover filtros de pesquisa ou usar outro segmento.</p>
      </div>`;
  }
  if (!rows.length) {
    return `
      <div class="radar-empty">
        <span class="radar-empty-icon" aria-hidden="true"></span>
        <strong>Nenhum resultado atende aos filtros</strong>
        <p>Os dados existem, mas a combinação atual de filtros locais não deixou nenhuma empresa visível.</p>
        <button class="btn" type="button" data-action="radar-clear-result-filters">Limpar filtros de resultado</button>
      </div>`;
  }
  return '';
}

function renderBulkBar() {
  const bar = document.getElementById('radar-bulk-bar');
  if (!bar) return;
  const count = radar.selected.size;
  bar.hidden = count === 0;
  const label = document.getElementById('radar-selected-count');
  if (label) label.textContent = String(count);
}

function renderResults({ fit = false } = {}) {
  const rows = filteredResults();
  const list = document.getElementById('radar-results-body');
  if (list) {
    list.innerHTML = rows.length ? rows.map(resultRowMarkup).join('') : resultsEmptyMarkup(rows);
  }
  const counts = document.getElementById('radar-result-counts');
  if (counts) {
    const mapped = rows.filter(hasCoordinates).length;
    const saved = rows.filter((result) => result.saved).length;
    counts.textContent = `${fmtNumber(rows.length)} de ${fmtNumber(radar.results.length)} empresa(s) · ${fmtNumber(mapped)} no mapa · ${fmtNumber(saved)} no CRM`;
  }
  const exportButton = document.getElementById('radar-export-button');
  if (exportButton) {
    exportButton.disabled = !rows.length;
  }
  const saveFiltered = document.getElementById('radar-save-filtered');
  if (saveFiltered) saveFiltered.disabled = !rows.some((result) => !result.saved);
  const checkAll = document.getElementById('radar-check-all');
  if (checkAll) {
    checkAll.checked = rows.length > 0 && rows.every((result) => radar.selected.has(result.id));
    checkAll.indeterminate = rows.some((result) => radar.selected.has(result.id)) && !checkAll.checked;
  }
  if (radar.selectedId && !rows.some((result) => result.id === radar.selectedId)) {
    radar.selectedId = null;
  }
  renderMarkers(rows);
  renderBulkBar();
  if (fit) fitResults(rows);
}

function updateMapOverlay(rows) {
  const overlay = document.getElementById('radar-map-overlay');
  if (!overlay) return;
  const mapped = rows.filter(hasCoordinates).length;
  let message = '';
  if (!window.L) {
    message = 'Mapa indisponível. Recarregue a página.';
  } else if (!radar.search) {
    message = 'Selecione a localização e execute uma pesquisa para visualizar as empresas.';
  } else if (isActive()) {
    message = 'Pesquisa em andamento. Os marcadores aparecerão automaticamente ao concluir.';
  } else if (!radar.results.length) {
    message =
      radar.search.status === 'failed'
        ? 'A pesquisa falhou. Consulte a mensagem acima.'
        : 'Nenhuma empresa encontrada para esta pesquisa.';
  } else if (!mapped) {
    message = radar.results.length
      ? 'As empresas retornadas não possuem coordenadas válidas para o mapa. Veja a lista ao lado.'
      : 'Nenhum marcador disponível.';
  }
  overlay.hidden = !message;
  overlay.innerHTML = message ? `<span>${esc(message)}</span>` : '';
}

function updateMarkerSelection() {
  for (const [id, marker] of radar.markers) {
    const element = marker.getElement();
    if (element) element.classList.toggle('is-selected', id === radar.selectedId);
    if (id === radar.selectedId) marker.setZIndexOffset(1000);
    else marker.setZIndexOffset(0);
  }
}

function selectResult(id, { fromMap = false, openPopup = true } = {}) {
  const result = radar.results.find((item) => item.id === id);
  if (!result) return;
  radar.selectedId = id;
  document.querySelectorAll('[data-radar-result]').forEach((element) => {
    element.classList.toggle('is-selected', element.dataset.radarResult === id);
  });
  updateMarkerSelection();
  const marker = radar.markers.get(id);
  if (marker && radar.map && hasCoordinates(result)) {
    if (fromMap) {
      if (openPopup) marker.openPopup();
      radar.map.panTo([Number(result.latitude), Number(result.longitude)], { animate: true });
    } else if (radar.cluster) {
      radar.cluster.zoomToShowLayer(marker, () => {
        if (state.route !== 'radar' || !radar.map) return;
        updateMarkerSelection();
        radar.map.panInside([Number(result.latitude), Number(result.longitude)]);
        if (openPopup) marker.openPopup();
      });
    }
  }
  if (!fromMap) {
    const row = document.querySelector(`[data-radar-result="${CSS.escape(id)}"]`);
    row?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function historyMarkup() {
  if (radar.history === null) return '<p class="small muted">Carregando histórico...</p>';
  if (!radar.history.length) {
    return '<p class="small muted">Nenhuma pesquisa realizada. O histórico aparecerá aqui.</p>';
  }
  return radar.history
    .map((search) => {
      const current = radar.search?.id === search.id;
      return `
        <div class="radar-history-item${current ? ' is-current' : ''}">
          <div>
            <strong>${esc(search.name)}</strong>
            <small>${esc(search.location.label)} · ${esc(fmtRelative(search.createdAt))}</small>
            <small>${fmtNumber(search.resultsCount)} resultado(s) · ${esc(RADAR_STATUS_LABELS[search.status] ?? search.status)}</small>
          </div>
          <div class="radar-history-actions">
            ${search.isSaved ? '<span class="badge badge-success">Salva</span>' : ''}
            <button class="btn btn-sm" type="button" data-action="radar-open-search" data-id="${esc(search.id)}">Abrir</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="radar-repeat-search" data-id="${esc(search.id)}">Repetir</button>
          </div>
        </div>`;
    })
    .join('');
}

function renderHistory() {
  const target = document.getElementById('radar-history-body');
  if (target) target.innerHTML = historyMarkup();
  const count = document.getElementById('radar-history-count');
  if (count) count.textContent = String(radar.history?.length ?? 0);
}

async function loadHistory() {
  const seq = ++radar.historySeq;
  const userId = state.user?.id;
  let searches = [];
  try {
    const data = await api('/api/radar/searches?limit=50');
    searches = Array.isArray(data.searches) ? data.searches : [];
  } catch {
    searches = [];
  }
  if (seq !== radar.historySeq || userId !== radar.userId || state.route !== 'radar') return;
  radar.history = searches;
  renderHistory();
}

function mapHeadPlaceholder() {
  return `
    <div class="radar-map-title">
      <div class="row"><h2>Mapa de oportunidades</h2></div>
      <p>Use os filtros para preparar uma pesquisa geográfica.</p>
    </div>
    <div class="radar-map-actions">
      <button class="btn btn-sm radar-mobile-filter" type="button" data-action="radar-filters-toggle">Filtros</button>
      <button class="btn btn-sm" type="button" disabled>Enquadrar</button>
      <button class="btn btn-sm" type="button" disabled>Salvar pesquisa</button>
      <button class="btn btn-sm btn-ghost" type="button" disabled>Nova pesquisa</button>
    </div>`;
}

function radarPageMarkup() {
  const location = radar.location;
  return `
    <div class="radar-layout">
      <aside class="panel radar-filter-panel" id="radar-filter-panel" aria-label="Filtros do Radar">
        <div class="panel-head radar-filter-head">
          <div>
            <h2>Filtros da prospecção</h2>
            <p id="radar-filter-count">Sem filtros ativos</p>
          </div>
          <button class="btn btn-ghost btn-icon radar-filter-close" type="button" data-action="radar-filters-toggle" aria-label="Fechar filtros">×</button>
        </div>
        <div class="radar-filter-scroll">
          <form id="radar-filters-form" class="radar-filter-form" data-form="radar" novalidate>
            <div class="form-error" data-radar-form-error hidden></div>

            <details class="radar-filter-group" open>
              <summary><span>Localização</span><span class="radar-scope-badge">pesquisa</span></summary>
              <div class="radar-filter-body">
                <label class="field field-full">
                  <span>Endereço, cidade ou região</span>
                  <span class="radar-autocomplete">
                    <input id="radar-location-input" type="text" value="${esc(radar.query)}" placeholder="Ex.: Campinas, SP, Brasil" autocomplete="off" aria-autocomplete="list" aria-controls="radar-location-suggestions" aria-expanded="false" />
                    <span id="radar-location-suggestions" class="radar-location-suggestions" role="listbox" hidden></span>
                  </span>
                  <span class="hint">Digite ao menos 3 caracteres e selecione uma sugestão.</span>
                </label>
                <div id="radar-location-selected">${locationSelectedMarkup()}</div>
                <div class="form-grid">
                  <label class="field">
                    <span>País</span>
                    <input type="text" name="country" maxlength="80" value="${esc(radar.country)}" placeholder="Brasil" />
                  </label>
                  <label class="field">
                    <span>Raio (km)</span>
                    <input type="number" name="radius" min="1" max="50" step="1" value="${esc(filterValue(radar.radiusKm))}" placeholder="Ex.: 10" />
                    <span class="hint">Opcional. Define um ponto central de 1 a 50 km.</span>
                  </label>
                </div>
                <label class="checkbox-row"><input type="checkbox" name="centerMap" ${filterCheckbox(radar.centerMap)} /> Centralizar o mapa ao selecionar a localidade</label>
                <p class="hint radar-hint-box">Uma localização por pesquisa. Para várias regiões, salve e repita a pesquisa com outra localidade.</p>
              </div>
            </details>

            <details class="radar-filter-group" open>
              <summary><span>Segmento e atividade</span><span class="radar-scope-badge">pesquisa</span></summary>
              <div class="radar-filter-body">
                <label class="field">
                  <span>Segmentos <small class="muted">(até 5, separados por vírgula)</small></span>
                  <input id="radar-segments" type="text" name="segments" maxlength="500" value="${esc(filterSegmentsText())}" placeholder="restaurantes, clínicas odontológicas" />
                </label>
                <div class="radar-quick-segments">
                  ${[
                    'restaurantes',
                    'clínicas odontológicas',
                    'oficinas mecânicas',
                    'imobiliárias',
                    'salões de beleza',
                    'academias',
                    'clínicas médicas',
                    'pet shops',
                  ]
                    .map(
                      (segment) =>
                        `<button class="badge badge-accent" type="button" data-action="radar-add-segment" data-value="${esc(segment)}">${esc(segment)}</button>`,
                    )
                    .join('')}
                </div>
                <label class="field">
                  <span>Nicho ou palavra-chave</span>
                  <input type="text" name="keyword" maxlength="120" value="${esc(radar.filters.keyword)}" placeholder="Ex.: delivery, estética, consultoria" />
                  <span class="hint">Combinado com o primeiro segmento quando ambos são informados.</span>
                </label>
                <label class="field">
                  <span>Nome da empresa</span>
                  <input type="text" name="companyName" maxlength="160" value="${esc(radar.filters.companyName)}" placeholder="Ex.: Rede Master" />
                </label>
                <div class="form-grid">
                  <label class="field">
                    <span>Incluir palavras</span>
                    <input type="text" name="includeKeywords" value="${esc(radar.filters.includeKeywords.join(', '))}" placeholder="pizza, centro" />
                  </label>
                  <label class="field">
                    <span>Excluir palavras</span>
                    <input type="text" name="excludeKeywords" value="${esc(radar.filters.excludeKeywords.join(', '))}" placeholder="franquia, shopping" />
                  </label>
                </div>
                <p class="hint radar-hint-box">Palavras de inclusão e exclusão são aplicadas aos resultados carregados, sem nova pesquisa.</p>
              </div>
            </details>

            <details class="radar-filter-group">
              <summary><span>Presença digital e pesquisa</span><span class="radar-scope-badge">pesquisa</span></summary>
              <div class="radar-filter-body">
                <div class="form-grid">
                  <label class="field">
                    <span>Site cadastrado</span>
                    <select name="website">
                      <option value="all"${selectedOption('all', radar.filters.website)}>Qualquer presença</option>
                      <option value="with"${selectedOption('with', radar.filters.website)}>Com site informado</option>
                      <option value="without"${selectedOption('without', radar.filters.website)}>Sem site cadastrado</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Nota mínima</span>
                    <select name="minRating">
                      <option value=""${selectedOption('', radar.filters.minRating)}>Qualquer nota</option>
                      <option value="3"${selectedOption('3', radar.filters.minRating)}>3,0 ou mais</option>
                      <option value="3.5"${selectedOption('3.5', radar.filters.minRating)}>3,5 ou mais</option>
                      <option value="4"${selectedOption('4', radar.filters.minRating)}>4,0 ou mais</option>
                      <option value="4.5"${selectedOption('4.5', radar.filters.minRating)}>4,5 ou mais</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Avaliações mínimas</span>
                    <input type="number" name="minReviews" min="0" step="1" value="${esc(filterValue(radar.filters.minReviews))}" placeholder="Ex.: 5" />
                  </label>
                  <label class="field">
                    <span>Limite de resultados</span>
                    <select name="limit">
                      ${[1, 2, 3, 4, 5].map((value) => `<option value="${value}"${selectedOption(value, radar.limit)}>${value} ${value === 1 ? 'resultado' : 'resultados'}</option>`).join('')}
                    </select>
                  </label>
                </div>
                <label class="checkbox-row"><input type="checkbox" name="activeOnly" ${filterCheckbox(radar.filters.activeOnly)} /> Excluir locais permanentemente ou temporariamente fechados</label>
                <p class="hint radar-hint-box">Faturamento e quantidade de funcionários não estão disponíveis. Redes sociais e e-mails não são incluídos nesta pesquisa; e-mail e site verificado aparecem após salvar e enriquecer o lead no CRM.</p>
              </div>
            </details>

            <details class="radar-filter-group">
              <summary><span>Qualificação e CRM</span><span class="radar-scope-badge radar-scope-local">lista/mapa</span></summary>
              <div class="radar-filter-body">
                <div class="form-grid">
                  <label class="field">
                    <span>Score mínimo</span>
                    <input type="number" name="minScore" min="0" max="100" step="1" value="${esc(filterValue(radar.filters.minScore))}" placeholder="0" />
                  </label>
                  <label class="field">
                    <span>Score máximo</span>
                    <input type="number" name="maxScore" min="0" max="100" step="1" value="${esc(filterValue(radar.filters.maxScore))}" placeholder="100" />
                  </label>
                  <label class="field">
                    <span>Telefone</span>
                    <select name="phonePresence">
                      <option value="any"${selectedOption('any', radar.filters.phonePresence)}>Qualquer</option>
                      <option value="with"${selectedOption('with', radar.filters.phonePresence)}>Com telefone</option>
                      <option value="without"${selectedOption('without', radar.filters.phonePresence)}>Sem telefone</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Endereço</span>
                    <select name="hasAddress">
                      <option value="any"${selectedOption('any', radar.filters.hasAddress)}>Qualquer</option>
                      <option value="with"${selectedOption('with', radar.filters.hasAddress)}>Com endereço</option>
                      <option value="without"${selectedOption('without', radar.filters.hasAddress)}>Sem endereço</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Status do site verificado</span>
                    <select name="siteStatus">
                      <option value=""${selectedOption('', radar.filters.siteStatus)}>Qualquer</option>
                      ${WEBSITE_STATUSES.map((status) => `<option value="${status}"${selectedOption(status, radar.filters.siteStatus)}>${esc(WEBSITE_LABELS[status] ?? status)}</option>`).join('')}
                    </select>
                  </label>
                  <label class="field">
                    <span>Atualizado nos últimos (dias)</span>
                    <input type="number" name="updatedDays" min="1" max="3650" step="1" value="${esc(filterValue(radar.filters.updatedDays))}" placeholder="Ex.: 30" />
                  </label>
                  <label class="field">
                    <span>Situação no CRM</span>
                    <select name="crmState">
                      <option value="all"${selectedOption('all', radar.filters.crmState)}>Todos</option>
                      <option value="unsaved"${selectedOption('unsaved', radar.filters.crmState)}>Fora do CRM</option>
                      <option value="saved"${selectedOption('saved', radar.filters.crmState)}>Salvos no CRM</option>
                      <option value="not_contacted"${selectedOption('not_contacted', radar.filters.crmState)}>Ainda não contatados</option>
                      <option value="contacted"${selectedOption('contacted', radar.filters.crmState)}>Já abordados</option>
                      <option value="closed"${selectedOption('closed', radar.filters.crmState)}>Vendidos ou perdidos</option>
                    </select>
                  </label>
                  <label class="field">
                    <span>Status comercial</span>
                    <select name="crmStatus">
                      <option value=""${selectedOption('', radar.filters.crmStatus)}>Qualquer</option>
                      ${LEAD_STATUSES.map((status) => `<option value="${status}"${selectedOption(status, radar.filters.crmStatus)}>${esc(STATUS_LABELS[status] ?? status)}</option>`).join('')}
                    </select>
                  </label>
                </div>
                <label class="checkbox-row"><input type="checkbox" name="noEmail" ${filterCheckbox(radar.filters.noEmail)} /> Sem e-mail no CRM</label>
                <label class="checkbox-row"><input type="checkbox" name="incompleteContact" ${filterCheckbox(radar.filters.incompleteContact)} /> Dados de contato incompletos (telefone, site ou e-mail ausente)</label>
                <label class="checkbox-row"><input type="checkbox" name="visibleArea" ${filterCheckbox(radar.filters.visibleArea)} /> Mostrar somente empresas na área visível do mapa</label>
                <p class="hint radar-hint-box">A verificação de site e a presença de e-mail dependem do lead estar salvo no CRM. Empresas fora do CRM aparecem como “site não verificado”.</p>
              </div>
            </details>

            <details class="radar-filter-group" open>
              <summary><span>Ordenação e execução</span><span class="radar-scope-badge">pesquisa</span></summary>
              <div class="radar-filter-body">
                <label class="field">
                  <span>Ordenar resultados</span>
                  <select name="sort">
                    <option value="score"${selectedOption('score', radar.filters.sort)}>Pontuação de oportunidade</option>
                    <option value="rating"${selectedOption('rating', radar.filters.sort)}>Melhor avaliação</option>
                    <option value="reviews"${selectedOption('reviews', radar.filters.sort)}>Mais avaliações</option>
                    <option value="name"${selectedOption('name', radar.filters.sort)}>Nome da empresa</option>
                    <option value="recent"${selectedOption('recent', radar.filters.sort)}>Atualização mais recente</option>
                  </select>
                </label>
                <div class="radar-execute-note">
                  <strong>Iniciar pesquisa</strong>
                  <span>Ao confirmar, a pesquisa pode consumir créditos e gerar cobrança. A quantidade de empresas pode variar.</span>
                </div>
                <button class="btn btn-primary btn-block" type="submit" ${radar.submitting ? 'disabled' : ''}>Revisar e executar pesquisa</button>
                <button class="btn btn-ghost btn-block" type="button" data-action="radar-reset">Limpar filtros</button>
              </div>
            </details>

            <div id="radar-active-filters" class="radar-chip-row"></div>
          </form>

          <div class="radar-history-panel">
            <div class="radar-history-head">
              <div>
                <h3>Histórico</h3>
                <p>Abrir uma pesquisa não inicia nova pesquisa.</p>
              </div>
              <span class="badge" id="radar-history-count">${radar.history?.length ?? 0}</span>
            </div>
            <div id="radar-history-body">${historyMarkup()}</div>
          </div>
        </div>
      </aside>
      <div class="radar-filter-scrim" id="radar-filter-scrim" data-action="radar-filters-toggle"></div>

      <div class="radar-stage">
        <section class="panel radar-map-panel">
          <div class="radar-map-head" id="radar-map-head">${mapHeadPlaceholder()}</div>
          <div class="radar-map-wrap">
            <div id="radar-map" class="radar-map" role="application" aria-label="Mapa de empresas do Radar"></div>
            <div id="radar-map-overlay" class="radar-map-overlay" hidden></div>
          </div>
          <div id="radar-search-status" class="radar-status"></div>
        </section>

        <section class="panel radar-results-panel">
          <div class="panel-head radar-results-head">
            <div>
              <div class="row"><h2>Empresas encontradas</h2><span class="badge" id="radar-result-counts">0 empresa(s)</span></div>
              <p>Selecione uma empresa para centralizar no mapa. Marque várias para ações em lote.</p>
            </div>
            <div class="row">
              <button class="btn btn-sm" type="button" id="radar-export-button" data-action="radar-export-filtered" disabled>Exportar CSV</button>
              <button class="btn btn-sm btn-ghost" type="button" id="radar-save-filtered" data-action="radar-save-filtered" disabled>Salvar filtrados no CRM</button>
            </div>
          </div>
          <div class="radar-bulk-bar" id="radar-bulk-bar" hidden>
            <strong><span id="radar-selected-count">0</span> selecionado(s)</strong>
            <button class="btn btn-sm btn-primary" type="button" data-action="radar-save-selected">Salvar selecionados</button>
            <button class="btn btn-sm" type="button" data-action="radar-export-selected">Exportar selecionados</button>
            <button class="btn btn-sm btn-ghost" type="button" data-action="radar-clear-selection">Limpar seleção</button>
          </div>
          <div class="radar-results-toolbar">
            <label class="checkbox-row"><input type="checkbox" id="radar-check-all" data-radar-check-all /> Selecionar todos os resultados filtrados</label>
          </div>
          <div id="radar-results-body" class="radar-results-body"></div>
        </section>
      </div>
    </div>`;
}

function renderRadarPage() {
  disposeMap();
  dom.main.innerHTML = radarPageMarkup();
  initMap();
  updateSearchChrome();
  updateSearchStatus();
  updateFilterSummary();
  renderResults({ fit: Boolean(radar.search?.status === 'completed' && radar.results.length) });
  renderHistory();
  if (isActive()) startRadarPolling();
}

export async function renderRadar(searchId) {
  if (!state.user) return;
  if (radar.userId !== state.user.id) {
    clearSearchState({ clearFilters: true });
    radar.historySeq += 1;
    radar.history = null;
    radar.userId = state.user.id;
  }
  const seq = ++radar.loadSeq;
  const targetId = searchId || radar.search?.id || null;
  if (targetId) {
    if (!radar.search || radar.search.id !== targetId) {
      dom.main.innerHTML = `
        <div class="radar-page-skeleton">
          <div class="skeleton skeleton-panel" style="height:560px"></div>
          <div class="skeleton skeleton-panel" style="height:300px"></div>
        </div>`;
    }
    try {
      const data = await api(`/api/radar/searches/${encodeURIComponent(targetId)}`);
      if (state.route !== 'radar' || seq !== radar.loadSeq) return;
      applySearchParams(data);
    } catch (error) {
      if (state.route !== 'radar' || seq !== radar.loadSeq) return;
      if (!radar.search) toast(errorMessage(error), 'error');
    }
  }
  if (state.route !== 'radar' || seq !== radar.loadSeq) return;
  renderRadarPage();
  void loadHistory();
}

function setButtonBusy(button, busy, label = 'Aguarde...') {
  if (!(button instanceof HTMLButtonElement)) return;
  if (busy) {
    if (!button.dataset.originalLabel) button.dataset.originalLabel = button.textContent ?? '';
    button.disabled = true;
    button.textContent = label;
  } else {
    button.disabled = false;
    if (button.dataset.originalLabel) button.textContent = button.dataset.originalLabel;
    delete button.dataset.originalLabel;
  }
}

function confirmModal({ title, body, confirmLabel, hint = '', danger = false, onConfirm }) {
  radar.pendingConfirm = onConfirm;
  openModalShell(`
    <div class="modal-head">
      <div class="modal-head-main">
        <h2>${esc(title)}</h2>
        <p>${esc(hint)}</p>
      </div>
      <button class="btn btn-ghost btn-icon" type="button" data-action="close-modal" aria-label="Fechar">×</button>
    </div>
    <div class="modal-body radar-confirm-body">${body}</div>
    <div class="modal-foot">
      <button class="btn" type="button" data-action="close-modal">Voltar</button>
      <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" type="button" data-action="radar-confirm-pending">${esc(confirmLabel)}</button>
    </div>`);
}

function openRunConfirmation() {
  readFiltersFromForm();
  if (!validateForm()) return;
  const name = recommendedName();
  const labels = activeFilterLabels(radar.filters);
  confirmModal({
    title: 'Revisar pesquisa do Radar',
    hint: 'Nenhuma pesquisa é iniciada antes da confirmação.',
    body: `
      <div class="radar-confirm-grid">
        <div><span class="small muted">Localização</span><strong>${esc(radar.location?.label || '')}</strong></div>
        <div><span class="small muted">Segmentos / nicho</span><strong>${esc(radar.filters.segments.join(', ') || radar.filters.keyword || radar.filters.companyName || '—')}</strong></div>
        <div><span class="small muted">Resultados</span><strong>Até ${fmtNumber(radar.limit)} empresas</strong></div>
        <div><span class="small muted">Raio</span><strong>${radar.radiusKm ? `${fmtNumber(radar.radiusKm)} km` : 'Automático'}</strong></div>
      </div>
      <label class="field"><span>Nome da pesquisa <small class="muted">(opcional)</small></span><input type="text" id="radar-run-name" maxlength="160" value="${esc(name)}" placeholder="Nome para localizar no histórico" /></label>
      ${labels.length ? `<div class="radar-chip-row">${labels.map((label) => `<span class="badge">${esc(label)}</span>`).join('')}</div>` : ''}
      <div class="notice notice-warning"><span><strong>Atenção:</strong> esta pesquisa pode consumir créditos e gerar cobrança. A quantidade de empresas encontrada pode variar.</span></div>
      <p class="small muted">Filtros de palavras, score, CRM, status de site e área visível são aplicados localmente aos resultados.</p>`,
    confirmLabel: 'Confirmar e executar',
    onConfirm: async (button) => {
      setButtonBusy(button, true, 'Iniciando...');
      try {
        await executeSearch();
      } finally {
        setButtonBusy(button, false);
      }
    },
  });
}

async function executeSearch() {
  if (radar.submitting) return;
  radar.submitting = true;
  try {
    const body = {
      name: document.getElementById('radar-run-name')?.value || undefined,
      location: {
        query: radar.location?.label || radar.query,
        label: radar.location?.label,
        latitude: radar.location?.latitude,
        longitude: radar.location?.longitude,
        country: radar.location?.country,
        countryCode: radar.location?.countryCode || undefined,
      },
      radiusKm: radar.radiusKm,
      limit: radar.limit,
      filters: radar.filters,
    };
    const data = await api('/api/radar/searches', { method: 'POST', body });
    if (state.route !== 'radar') return;
    closeModal();
    radar.search = data.search;
    radar.results = [];
    radar.selected.clear();
    radar.selectedId = null;
    history.replaceState(null, '', `#/radar/${data.search.id}`);
    updateSearchChrome();
    updateSearchStatus();
    renderResults();
    drawAreaCircle();
    renderHistory();
    startRadarPolling();
    toast('Pesquisa iniciada. Os resultados aparecerão automaticamente.', 'success');
    document.querySelector('.radar-stage')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } catch (error) {
    toast(errorMessage(error), 'error', 7000);
    formError(errorMessage(error));
    throw error;
  } finally {
    radar.submitting = false;
  }
}

function startRadarPolling() {
  stopRadarPolling();
  const searchId = radar.search?.id;
  if (!searchId) return;
  const timer = window.setInterval(async () => {
    if (state.route !== 'radar' || radar.search?.id !== searchId) {
      stopRadarPolling();
      return;
    }
    if (radar.pollBusy) return;
    radar.pollBusy = true;
    const wasActive = isActive();
    try {
      const data = await api(`/api/radar/searches/${encodeURIComponent(searchId)}`);
      if (state.route !== 'radar' || radar.search?.id !== searchId) return;
      applyRefreshedSearch(data);
      updateSearchChrome();
      updateSearchStatus();
      renderResults({ fit: wasActive && data.search.status === 'completed' });
      renderHistory();
      if (!ACTIVE_STATUSES.has(data.search.status)) {
        stopRadarPolling();
        if (data.search.status === 'completed') {
          toast(`Pesquisa concluída: ${fmtNumber(data.search.resultsCount)} empresa(s).`, 'success');
        } else if (data.search.status === 'failed') {
          toast(`Pesquisa falhou: ${data.search.errorMessage || 'erro desconhecido'}`, 'error', 8000);
        }
        void loadHistory();
      }
    } catch {
      stopRadarPolling();
    } finally {
      radar.pollBusy = false;
    }
  }, 3000);
  radar.timer = timer;
}

export function stopRadarPolling() {
  if (radar.timer) {
    window.clearInterval(radar.timer);
    radar.timer = null;
  }
  radar.pollBusy = false;
}

export async function refreshRadarAfterLeadChange() {
  if (state.route !== 'radar' || !radar.search || isActive()) return;
  await refreshCurrentSearch();
}

export function destroyRadar() {
  radar.loadSeq += 1;
  stopRadarPolling();
  if (radar.locationTimer) {
    window.clearTimeout(radar.locationTimer);
    radar.locationTimer = null;
  }
  if (radar.filterTimer) {
    window.clearTimeout(radar.filterTimer);
    radar.filterTimer = null;
  }
  if (radar.moveTimer) {
    window.clearTimeout(radar.moveTimer);
    radar.moveTimer = null;
  }
  radar.suggestionSeq += 1;
  radar.pendingConfirm = null;
  disposeMap();
}

async function openSearch(searchId, repeat = false) {
  if (!searchId) return;
  const seq = ++radar.loadSeq;
  try {
    const data = await api(`/api/radar/searches/${encodeURIComponent(searchId)}`);
    if (state.route !== 'radar' || seq !== radar.loadSeq) return;
    applySearchParams(data);
    history.replaceState(null, '', `#/radar/${searchId}`);
    renderRadarPage();
    if (repeat) {
      toast('Parâmetros restaurados. Revise e confirme para iniciar uma nova pesquisa.', 'info', 7000);
      window.setTimeout(
        () =>
          document
            .getElementById('radar-filters-form')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        80,
      );
    }
    void loadHistory();
  } catch (error) {
    if (state.route === 'radar' && seq === radar.loadSeq) toast(errorMessage(error), 'error');
  }
}

function openSaveSearchModal() {
  if (!radar.search) return;
  confirmModal({
    title: 'Salvar pesquisa',
    hint: 'Ela continuará disponível no histórico para reabrir os parâmetros.',
    body: `
      <label class="field"><span>Nome da pesquisa</span><input type="text" id="radar-save-name" maxlength="160" value="${esc(radar.search.name)}" /></label>
      <p class="small muted">Salvar não inicia uma nova pesquisa.</p>`,
    confirmLabel: 'Salvar pesquisa',
    onConfirm: async (button) => {
      setButtonBusy(button, true, 'Salvando...');
      try {
        const name = document.getElementById('radar-save-name')?.value || radar.search.name;
        const data = await api(`/api/radar/searches/${encodeURIComponent(radar.search.id)}`, {
          method: 'PATCH',
          body: { name, isSaved: true },
        });
        radar.search = data.search;
        closeModal();
        updateSearchChrome();
        toast('Pesquisa salva no histórico.', 'success');
        void loadHistory();
      } catch (error) {
        toast(errorMessage(error), 'error');
      } finally {
        setButtonBusy(button, false);
      }
    },
  });
  window.setTimeout(() => document.getElementById('radar-save-name')?.select(), 50);
}

function resultById(id) {
  return radar.results.find((result) => result.id === id);
}

function detailReasons(result) {
  if (!Array.isArray(result.scoreReasons) || !result.scoreReasons.length) {
    return '<p class="small muted">A pontuação usa os critérios atuais e os dados disponíveis.</p>';
  }
  return `
    <ul class="radar-score-reasons">
      ${result.scoreReasons
        .map(
          (reason) =>
            `<li><span>${esc(reason.label ?? reason.code ?? 'Critério')}</span><strong>+${fmtNumber(reason.points ?? 0)}</strong></li>`,
        )
        .join('')}
    </ul>`;
}

function renderResultDetail(resultId) {
  const result = resultById(resultId);
  if (!result) return;
  const address = [result.address, result.city, result.state, result.postalCode].filter(Boolean).join(' · ');
  const contactRows = [];
  if (result.phone) contactRows.push(['Telefone', esc(result.phone)]);
  if (result.email) contactRows.push(['E-mail', esc(result.email)]);
  if (result.website)
    contactRows.push(['Site', externalLink(result.website, hostname(result.website) || 'Abrir site')]);
  if (result.googleMapsUrl) contactRows.push(['Mapa', externalLink(result.googleMapsUrl, 'Abrir ficha')]);
  const statusSelect = result.saved
    ? `
      <label class="field"><span>Qualificação comercial</span>
        <select data-radar-status data-lead-id="${esc(result.leadId)}" data-result-id="${esc(result.id)}">
          ${LEAD_STATUSES.map((status) => option(status, STATUS_LABELS[status] ?? status, result.crmStatus)).join('')}
        </select>
      </label>`
    : '';
  openModalShell(`
    <div class="modal-head">
      <div class="modal-head-main">
        <div class="row">
          <h2>${esc(result.name)}</h2>
          ${scorePill(result.score)}
          ${resultCrmMarkup(result)}
        </div>
        <p>${esc(result.category || 'Categoria não informada')}${result.rating !== null ? ` · ★ ${esc(Number(result.rating).toFixed(1))} (${fmtNumber(result.reviewsCount ?? 0)})` : ''}</p>
      </div>
      <button class="btn btn-ghost btn-icon" type="button" data-action="close-modal" aria-label="Fechar">×</button>
    </div>
    <div class="modal-body radar-detail-body">
      <div class="radar-detail-grid">
        <div class="stack">
          <div>
            <h3>Contato e localização</h3>
            ${address ? `<p class="small">${esc(address)}</p>` : '<p class="small muted">Endereço não informado.</p>'}
            <div class="radar-detail-contact">
              ${contactRows.length ? contactRows.map(([label, value]) => `<div><span>${esc(label)}</span>${value}</div>`).join('') : '<p class="small muted">Nenhum contato público disponível.</p>'}
            </div>
          </div>
          <div>
            <h3>Por que esta empresa pontuou</h3>
            ${detailReasons(result)}
          </div>
        </div>
        <div class="stack">
          <div class="radar-detail-side">
            <h3>Ações</h3>
            <button class="btn" type="button" data-action="radar-center" data-id="${esc(result.id)}">Centralizar no mapa</button>
            ${
              result.saved
                ? `<button class="btn" type="button" data-action="radar-open-lead" data-id="${esc(result.leadId)}">Abrir no CRM</button>
                   <button class="btn ${result.doNotContact ? 'btn-danger-ghost' : 'btn-ghost'}" type="button" data-action="radar-dnc" data-id="${esc(result.id)}" data-value="${result.doNotContact ? 'false' : 'true'}">${result.doNotContact ? 'Remover não contatar' : 'Marcar não contatar'}</button>`
                : `<button class="btn btn-primary" type="button" data-action="radar-save-result" data-id="${esc(result.id)}">Salvar no CRM</button>
                   <p class="small muted">Salve no CRM para qualificar, marcar não contatar e verificar o site.</p>`
            }
            ${statusSelect}
          </div>
          <div class="radar-detail-side">
            <h3>Procedência</h3>
            <dl class="kv radar-detail-kv">
              <dt>Origem</dt><dd>Pesquisa de empresas</dd>
              <dt>Pesquisado em</dt><dd>${esc(fmtDate(result.scrapedAt, true))}</dd>
              <dt>Coordenadas</dt><dd>${hasCoordinates(result) ? `${Number(result.latitude).toFixed(5)}, ${Number(result.longitude).toFixed(5)}` : 'Não disponíveis'}</dd>
              <dt>Site</dt><dd>${result.websiteStatus ? websiteBadge(result.websiteStatus) : '<span class="badge">Não verificado</span>'}</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>
    <div class="modal-foot">
      <span class="small muted">O Radar não pesquisa e-mails nesta execução. Use o enriquecimento do lead no CRM quando disponível.</span>
      <button class="btn" type="button" data-action="close-modal">Fechar</button>
    </div>`);
}

async function refreshCurrentSearch({ fit = false } = {}) {
  const id = radar.search?.id;
  if (!id) return;
  try {
    const data = await api(`/api/radar/searches/${encodeURIComponent(id)}`);
    if (state.route !== 'radar' || radar.search?.id !== id) return;
    applyRefreshedSearch(data);
    updateSearchChrome();
    updateSearchStatus();
    renderResults({ fit });
    void loadHistory();
  } catch (error) {
    toast(errorMessage(error), 'error');
  }
}

async function saveResults(resultIds) {
  if (!radar.search) return false;
  if (!resultIds.length) {
    toast('Nenhum resultado selecionado.', 'warning');
    return false;
  }
  try {
    const data = await api(`/api/radar/searches/${encodeURIComponent(radar.search.id)}/save-results`, {
      method: 'POST',
      body: { resultIds },
    });
    toast(`${fmtNumber(data.saved)} empresa(s) salva(s) no CRM.`, 'success');
    await refreshCurrentSearch();
    return true;
  } catch (error) {
    toast(errorMessage(error), 'error', 7000);
    return false;
  }
}

function confirmBulkSave(ids, label) {
  if (!ids.length) {
    toast('Nenhum resultado disponível para salvar.', 'warning');
    return;
  }
  confirmModal({
    title: 'Salvar resultados no CRM',
    hint: 'Esta ação pode criar ou atualizar muitos registros.',
    body: `<p>Salvar <strong>${fmtNumber(ids.length)} ${esc(label)}</strong> no CRM? Empresas já existentes serão atualizadas com os dados do Radar.</p>`,
    confirmLabel: 'Salvar no CRM',
    onConfirm: async (button) => {
      setButtonBusy(button, true, 'Salvando...');
      try {
        const saved = await saveResults(ids);
        if (saved) closeModal();
      } finally {
        setButtonBusy(button, false);
      }
    },
  });
}

function exportResults(ids, label) {
  if (!radar.search) return;
  if (!ids.length) {
    toast('Nenhum resultado para exportar.', 'warning');
    return;
  }
  const params = new URLSearchParams();
  if (ids.length) params.set('ids', ids.join(','));
  window.location.href = `/api/radar/searches/${encodeURIComponent(radar.search.id)}/export.csv?${params.toString()}`;
  toast(`Exportação de ${fmtNumber(ids.length)} ${label} iniciada.`, 'info');
}

function resetFilters() {
  radar.filters = defaultFilters();
  radar.radiusKm = null;
  radar.limit = MAX_RESULTS;
  radar.centerMap = true;
  radar.country = 'Brasil';
  radar.location = null;
  radar.query = '';
  radar.suggestions = [];
  radar.suggestionsOpen = false;
  renderRadarPage();
}

function clearResultFilters() {
  const filters = radar.filters;
  radar.filters = {
    ...filters,
    includeKeywords: [],
    excludeKeywords: [],
    minRating: null,
    minReviews: null,
    phonePresence: 'any',
    hasAddress: 'any',
    noEmail: false,
    incompleteContact: false,
    siteStatus: null,
    minScore: null,
    maxScore: null,
    crmState: 'all',
    crmStatus: null,
    updatedDays: null,
    visibleArea: false,
    sort: 'score',
  };
  renderRadarPage();
}

export async function handleRadarAction(element) {
  const action = element.dataset.action;
  const id = element.dataset.id;
  if (!action?.startsWith('radar-')) return;
  if (action === 'radar-filters-toggle') {
    const panel = document.getElementById('radar-filter-panel');
    const scrim = document.getElementById('radar-filter-scrim');
    const open = !panel?.classList.contains('is-open');
    panel?.classList.toggle('is-open', open);
    scrim?.classList.toggle('is-visible', open);
    return;
  }
  if (action === 'radar-pick-location') {
    pickLocation(Number(element.dataset.index));
    return;
  }
  if (action === 'radar-add-segment') {
    const input = document.getElementById('radar-segments');
    if (!(input instanceof HTMLInputElement)) return;
    const segments = splitList(input.value);
    const value = element.dataset.value || '';
    if (segments.length >= 5 && !segments.includes(value)) {
      toast('Use no máximo 5 segmentos.', 'warning');
      return;
    }
    if (value && !segments.includes(value)) segments.push(value);
    input.value = segments.join(', ');
    readFiltersFromForm();
    updateFilterSummary();
    input.focus();
    return;
  }
  if (action === 'radar-select') {
    if (id) selectResult(id);
    return;
  }
  if (action === 'radar-detail') {
    if (id) renderResultDetail(id);
    return;
  }
  if (action === 'radar-center') {
    if (!id) return;
    closeModal();
    selectResult(id);
    document.querySelector('.radar-map-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    return;
  }
  if (action === 'radar-open-lead') {
    if (!id) return;
    closeModal();
    await openLead(id, false);
    return;
  }
  if (action === 'radar-save-result') {
    if (!id) return;
    const hadDetail = Boolean(dom.modal.innerHTML);
    setButtonBusy(element, true, 'Salvando...');
    await saveResults([id]);
    setButtonBusy(element, false);
    if (hadDetail) renderResultDetail(id);
    return;
  }
  if (action === 'radar-save-selected') {
    confirmBulkSave([...radar.selected], 'resultado(s) selecionado(s)');
    return;
  }
  if (action === 'radar-save-filtered') {
    confirmBulkSave(
      filteredResults()
        .filter((result) => !result.saved)
        .map((result) => result.id),
      'resultado(s) filtrado(s)',
    );
    return;
  }
  if (action === 'radar-clear-selection') {
    radar.selected.clear();
    document.querySelectorAll('[data-radar-check]').forEach((checkbox) => {
      checkbox.checked = false;
    });
    const checkAll = document.getElementById('radar-check-all');
    if (checkAll) {
      checkAll.checked = false;
      checkAll.indeterminate = false;
    }
    renderBulkBar();
    return;
  }
  if (action === 'radar-export-filtered') {
    exportResults(
      filteredResults().map((result) => result.id),
      'resultado(s) filtrado(s)',
    );
    return;
  }
  if (action === 'radar-export-selected') {
    exportResults([...radar.selected], 'resultado(s) selecionado(s)');
    return;
  }
  if (action === 'radar-fit') {
    fitResults(filteredResults());
    return;
  }
  if (action === 'radar-save-search') {
    openSaveSearchModal();
    return;
  }
  if (action === 'radar-reset') {
    resetFilters();
    return;
  }
  if (action === 'radar-clear-result-filters') {
    clearResultFilters();
    return;
  }
  if (action === 'radar-new') {
    clearSearchState();
    history.replaceState(null, '', '#/radar');
    renderRadarPage();
    return;
  }
  if (action === 'radar-rerun') {
    openRunConfirmation();
    return;
  }
  if (action === 'radar-open-search' || action === 'radar-repeat-search') {
    if (id) await openSearch(id, action === 'radar-repeat-search');
    return;
  }
  if (action === 'radar-cancel') {
    confirmModal({
      title: 'Cancelar pesquisa',
      hint: 'A pesquisa será interrompida.',
      body: '<p>Cancelar esta pesquisa? Os resultados parciais podem não ser importados e os custos já incorridos não são reembolsados.</p>',
      confirmLabel: 'Cancelar pesquisa',
      danger: true,
      onConfirm: async (button) => {
        setButtonBusy(button, true, 'Cancelando...');
        try {
          const data = await api(`/api/radar/searches/${encodeURIComponent(radar.search.id)}/cancel`, {
            method: 'POST',
          });
          radar.search = data.search;
          closeModal();
          stopRadarPolling();
          updateSearchChrome();
          updateSearchStatus();
          renderResults();
          void loadHistory();
          toast('Pesquisa cancelada.', 'warning');
        } catch (error) {
          toast(errorMessage(error), 'error');
        } finally {
          setButtonBusy(button, false);
        }
      },
    });
    return;
  }
  if (action === 'radar-dnc') {
    const result = resultById(id);
    if (!result?.leadId) return;
    const value = element.dataset.value === 'true';
    setButtonBusy(element, true, 'Atualizando...');
    try {
      await api(`/api/leads/${encodeURIComponent(result.leadId)}`, {
        method: 'PATCH',
        body: value
          ? { doNotContact: true, status: 'nao_contatar' }
          : { doNotContact: false, status: 'novo' },
      });
      toast(
        value ? 'Empresa marcada como não contatar.' : 'Marcação de não contatar removida.',
        value ? 'warning' : 'success',
      );
      await refreshCurrentSearch();
      renderResultDetail(id);
    } catch (error) {
      toast(errorMessage(error), 'error');
    } finally {
      setButtonBusy(element, false);
    }
    return;
  }
  if (action === 'radar-confirm-pending') {
    const callback = radar.pendingConfirm;
    if (!callback || radar.confirmBusy) return;
    radar.confirmBusy = true;
    try {
      await callback(element);
      if (radar.pendingConfirm === callback) radar.pendingConfirm = null;
    } catch {
      radar.pendingConfirm = callback;
    } finally {
      radar.confirmBusy = false;
    }
  }
}

export async function handleRadarSubmit(form) {
  if (!(form instanceof HTMLFormElement)) return;
  readFiltersFromForm();
  if (!validateForm()) return;
  openRunConfirmation();
}

export function handleRadarInput(target) {
  if (!(target instanceof HTMLInputElement)) return;
  if (target.id === 'radar-location-input') {
    radar.query = target.value;
    if (radar.location && target.value !== radar.location.label) {
      radar.location = null;
      updateLocationSelected();
      drawAreaCircle();
    }
    scheduleLocationSearch();
    return;
  }
  if (!target.closest('#radar-filters-form')) return;
  if (radar.filterTimer) window.clearTimeout(radar.filterTimer);
  radar.filterTimer = window.setTimeout(() => {
    radar.filterTimer = null;
    if (state.route !== 'radar') return;
    readFiltersFromForm();
    updateFilterSummary();
    drawAreaCircle();
    renderResults();
  }, 180);
}

export async function handleRadarChange(target) {
  if (!(target instanceof Element)) return;
  if (target.matches('[data-radar-check]')) {
    const input = target;
    if (!(input instanceof HTMLInputElement)) return;
    if (input.checked) radar.selected.add(input.value);
    else radar.selected.delete(input.value);
    const row = input.closest('[data-radar-result]');
    row?.classList.toggle('is-selected-soft', input.checked);
    const checkAll = document.getElementById('radar-check-all');
    const rows = filteredResults();
    if (checkAll) {
      checkAll.checked = rows.length > 0 && rows.every((result) => radar.selected.has(result.id));
      checkAll.indeterminate = rows.some((result) => radar.selected.has(result.id)) && !checkAll.checked;
    }
    renderBulkBar();
    return;
  }
  if (target.matches('[data-radar-check-all]')) {
    const input = target;
    if (!(input instanceof HTMLInputElement)) return;
    const rows = filteredResults();
    for (const result of rows) {
      if (input.checked) radar.selected.add(result.id);
      else radar.selected.delete(result.id);
    }
    document.querySelectorAll('[data-radar-check]').forEach((checkbox) => {
      if (checkbox instanceof HTMLInputElement) checkbox.checked = input.checked;
    });
    document.querySelectorAll('[data-radar-result]').forEach((row) => {
      row.classList.toggle('is-selected-soft', input.checked);
    });
    renderBulkBar();
    return;
  }
  if (target.matches('[data-radar-status]')) {
    const input = target;
    if (!(input instanceof HTMLSelectElement)) return;
    const leadId = input.dataset.leadId;
    if (!leadId) return;
    input.disabled = true;
    try {
      await api(`/api/leads/${encodeURIComponent(leadId)}`, {
        method: 'PATCH',
        body: { status: input.value },
      });
      toast('Qualificação comercial atualizada.', 'success');
      await refreshCurrentSearch();
      if (input.dataset.resultId) renderResultDetail(input.dataset.resultId);
    } catch (error) {
      toast(errorMessage(error), 'error');
      input.disabled = false;
    }
    return;
  }
  if (target.matches('#radar-filters-form input, #radar-filters-form select')) {
    readFiltersFromForm();
    updateFilterSummary();
    drawAreaCircle();
    renderResults();
  }
}

document.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  if (!target.closest('.radar-autocomplete')) {
    radar.suggestionsOpen = false;
    updateLocationSuggestions();
  }
});

document.addEventListener('keydown', (event) => {
  const target = event.target;
  if (target instanceof Element && target.matches('#radar-location-input') && event.key === 'Escape') {
    radar.suggestionsOpen = false;
    updateLocationSuggestions();
    return;
  }
  if (event.key !== 'Enter' || state.route !== 'radar') return;
  if (!(target instanceof Element)) return;
  const row = target.closest('[data-action="radar-select"]');
  if (row && target === row) {
    event.preventDefault();
    selectResult(row.dataset.id);
  }
});
