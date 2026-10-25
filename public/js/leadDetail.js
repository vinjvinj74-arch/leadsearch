import {
  ACTIVITY_LABELS,
  ACTIVITY_TYPES,
  LEAD_STATUSES,
  SOURCE_LABELS,
  STATUS_LABELS,
  api,
  clearFormMessages,
  dom,
  errorMessage,
  esc,
  externalLink,
  fmtDate,
  fmtNumber,
  hostname,
  nl2br,
  openModalShell,
  option,
  setFormBusy,
  showFormError,
  state,
  statusBadge,
  toast,
  websiteBadge,
} from './core.js';

function leadModalSkeleton() {
  return `
    <div class="modal-head">
      <div class="modal-head-main">
        <h2>Carregando lead...</h2>
      </div>
      <button class="btn btn-ghost btn-icon modal-close" type="button" data-action="close-modal" aria-label="Fechar">×</button>
    </div>
    <div class="modal-body">
      <div class="skeleton skeleton-line" style="width:45%"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line"></div>
      <div class="skeleton skeleton-line" style="width:70%"></div>
    </div>`;
}

export async function openLead(id, updateHash = true) {
  if (!id) return;
  state.modalLeadId = id;
  state.modalLead = null;
  state.modalEditing = false;
  if (updateHash && state.route === 'leads') {
    history.replaceState(null, '', `#/leads/${id}`);
  }
  openModalShell(leadModalSkeleton());
  try {
    const data = await api(`/api/leads/${encodeURIComponent(id)}`);
    if (state.modalLeadId !== id) return;
    state.modalLead = data.lead;
    renderLeadModal();
  } catch (error) {
    if (state.modalLeadId !== id) return;
    dom.modal.innerHTML = `
      <div class="modal-backdrop" data-modal-backdrop>
        <div class="modal modal-sm" role="dialog" aria-modal="true">
          <div class="modal-head">
            <div class="modal-head-main"><h2>Não foi possível abrir o lead</h2></div>
            <button class="btn btn-ghost btn-icon" type="button" data-action="close-modal" aria-label="Fechar">×</button>
          </div>
          <div class="modal-body"><p class="small muted">${esc(errorMessage(error))}</p></div>
          <div class="modal-foot"><button class="btn" type="button" data-action="close-modal">Fechar</button></div>
        </div>
      </div>`;
  }
}

async function reloadLeadModal() {
  if (!state.modalLeadId) return;
  const data = await api(`/api/leads/${encodeURIComponent(state.modalLeadId)}`);
  state.modalLead = data.lead;
  renderLeadModal();
}

function scoreReasonList(reasons) {
  if (!reasons?.length) {
    return '<p class="small muted">Nenhum critério pontuado. Verifique o site ou recalcule o score.</p>';
  }
  return `<ul class="reason-list">${reasons
    .map(
      (reason) =>
        `<li><span>${esc(reason.label || reason.code)}</span><b>+${esc(reason.points ?? 0)}</b></li>`,
    )
    .join('')}</ul>`;
}

function contactsMarkup(lead) {
  if (!lead.contacts?.length) return '<p class="small muted">Nenhum contato extra coletado do site.</p>';
  return `<div class="contact-list">${lead.contacts
    .map(
      (contact) => `
      <div class="contact-item">
        <span>${esc(contact.value)}</span>
        <button class="btn btn-ghost btn-sm" type="button" data-action="copy-value" data-copy="${esc(contact.value)}" aria-label="Copiar ${esc(contact.value)}">Copiar</button>
      </div>`,
    )
    .join('')}</div>`;
}

function activityMarkup(activity) {
  const label = ACTIVITY_LABELS[activity.type] ?? activity.type;
  const transition =
    activity.fromStatus && activity.toStatus
      ? `<span class="badge">${esc(STATUS_LABELS[activity.fromStatus] ?? activity.fromStatus)} → ${esc(STATUS_LABELS[activity.toStatus] ?? activity.toStatus)}</span>`
      : '';
  return `
    <li class="timeline-item">
      <div class="timeline-meta">
        <span class="badge">${esc(label)}</span>
        <span>${esc(fmtDate(activity.createdAt, true))}</span>
        ${transition}
      </div>
      ${activity.note ? `<p>${nl2br(activity.note)}</p>` : ''}
      ${activity.nextAction ? `<span class="timeline-next">Próximo: ${esc(activity.nextAction)}${activity.nextActionAt ? ` · ${esc(fmtDate(activity.nextActionAt, true))}` : ''}</span>` : ''}
    </li>`;
}

function leadEditForm(lead) {
  return `
    <form class="form-stack" data-form="lead-edit" style="margin-bottom:18px">
      <div class="form-grid">
        <label class="field field-full"><span>Empresa</span><input type="text" name="name" required minlength="2" maxlength="180" value="${esc(lead.name)}" /></label>
        <label class="field"><span>Segmento</span><input type="text" name="segment" maxlength="120" value="${esc(lead.segment ?? '')}" /></label>
        <label class="field"><span>Status</span><select name="status" ${lead.doNotContact ? 'disabled' : ''}>${LEAD_STATUSES.map((status) => option(status, STATUS_LABELS[status], lead.status)).join('')}</select>${lead.doNotContact ? '<span class="hint">Remova a marcação de não contatar para alterar o status.</span>' : ''}</label>
        <label class="field"><span>Telefone</span><input type="tel" name="phone" maxlength="40" value="${esc(lead.phone ?? '')}" /></label>
        <label class="field"><span>E-mail</span><input type="email" name="email" maxlength="254" value="${esc(lead.email ?? '')}" /></label>
        <label class="field"><span>Site</span><input type="url" name="website" maxlength="500" value="${esc(lead.website ?? '')}" placeholder="https://" /></label>
        <label class="field"><span>Score manual (0-100)</span><input type="number" name="scoreOverride" min="0" max="100" value="${lead.scoreOverride ?? ''}" placeholder="Automático" /></label>
        <label class="field"><span>Cidade</span><input type="text" name="city" maxlength="100" value="${esc(lead.city ?? '')}" /></label>
        <label class="field"><span>UF / Estado</span><input type="text" name="state" maxlength="100" value="${esc(lead.state ?? '')}" /></label>
        <label class="field"><span>País</span><input type="text" name="country" maxlength="100" value="${esc(lead.country ?? '')}" /></label>
        <label class="field field-full"><span>Endereço</span><input type="text" name="address" maxlength="300" value="${esc(lead.address ?? '')}" /></label>
        <label class="field field-full"><span>Observação do histórico (opcional)</span><textarea name="note" maxlength="1000" rows="2" placeholder="Motivo da alteração"></textarea></label>
      </div>
      <p class="form-error" data-form-error role="alert" hidden></p>
      <div class="row">
        <button class="btn btn-primary" type="submit">Salvar alterações</button>
        <button class="btn btn-ghost" type="button" data-action="cancel-edit">Cancelar</button>
      </div>
    </form>`;
}

function leadModalMarkup(lead) {
  const score = Math.max(0, Math.min(100, Math.round(Number(lead.effectiveScore ?? 0))));
  const activities = lead.activities?.length
    ? lead.activities.map(activityMarkup).join('')
    : '<li class="timeline-item"><p class="small muted">Nenhuma atividade registrada ainda.</p></li>';
  const sources = lead.sources?.length
    ? lead.sources
        .map(
          (source) => `
          <div class="history-item">
            <div>
              <strong>${esc(SOURCE_LABELS[source.source] ?? source.source ?? 'Origem registrada')}</strong>
              <small>${esc(fmtDate(source.collectedAt, true))}${source.sourceUrl ? ` · ${esc(hostname(source.sourceUrl))}` : ''}</small>
            </div>
          </div>`,
        )
        .join('')
    : '<p class="small muted">Nenhuma origem registrada.</p>';

  return `
    <div class="modal-head">
      <div class="modal-head-main">
        <h2 id="lead-modal-title">${esc(lead.name)}</h2>
        <p>${esc([lead.segment, lead.city, lead.state].filter(Boolean).join(' · ') || 'Lead sem segmento ou localização')}</p>
        <div class="row" style="margin-top:8px">
          ${statusBadge(lead.status)}
          ${websiteBadge(lead.websiteStatus)}
          ${lead.doNotContact ? '<span class="badge badge-danger">Não contatar</span>' : ''}
          ${lead.scoreOverride !== null && lead.scoreOverride !== undefined ? '<span class="badge badge-accent">Score manual</span>' : ''}
        </div>
      </div>
      <div class="row">
        ${lead.googleMapsUrl ? externalLink(lead.googleMapsUrl, 'Mapa', 'class="btn btn-sm"') : ''}
        <button class="btn btn-ghost btn-icon modal-close" type="button" data-action="close-modal" aria-label="Fechar">×</button>
      </div>
    </div>
    <div class="modal-body">
      ${state.modalEditing ? leadEditForm(lead) : ''}

      <div class="action-row">
        <button class="btn btn-sm" type="button" data-action="lead-op" data-op="verify" ${!lead.website || state.modalBusy ? 'disabled' : ''}>Verificar site</button>
        <button class="btn btn-sm" type="button" data-action="lead-op" data-op="enrich" ${!lead.website || state.modalBusy ? 'disabled' : ''}>Enriquecer contatos</button>
        <button class="btn btn-sm" type="button" data-action="lead-op" data-op="score" ${state.modalBusy ? 'disabled' : ''}>Recalcular score</button>
        <button class="btn btn-sm ${lead.doNotContact ? 'btn-danger-ghost' : 'btn-ghost'}" type="button" data-action="lead-op" data-op="dnc" ${state.modalBusy ? 'disabled' : ''}>
          ${lead.doNotContact ? 'Remover não contatar' : 'Marcar não contatar'}
        </button>
        <button class="btn btn-sm" type="button" data-action="edit-lead" ${state.modalEditing ? 'disabled' : ''}>Editar dados</button>
        ${state.modalBusy ? '<span class="small muted">Processando...</span>' : ''}
      </div>

      <div class="detail-grid" style="margin-top:18px">
        <div>
          <div class="detail-section" style="margin-top:0">
            <h3>Dados do lead</h3>
            <div class="info-grid">
              <div class="info-item"><small>Telefone</small><span>${lead.phone ? esc(lead.phone) : '—'}</span></div>
              <div class="info-item"><small>E-mail</small><span>${lead.email ? esc(lead.email) : '—'}</span></div>
              <div class="info-item"><small>Site</small><span>${lead.website ? externalLink(lead.website, hostname(lead.website)) : '—'}</span></div>
              <div class="info-item"><small>Endereço</small><span>${esc(lead.address || '—')}</span></div>
              <div class="info-item"><small>País</small><span>${esc(lead.country || '—')}</span></div>
              <div class="info-item"><small>Avaliação</small><span>${lead.rating === null ? '—' : `${esc(lead.rating)} ★ (${fmtNumber(lead.reviewsCount)})`}</span></div>
              <div class="info-item"><small>Último contato</small><span>${esc(fmtDate(lead.lastContactedAt, true))}</span></div>
              <div class="info-item"><small>Site verificado</small><span>${esc(fmtDate(lead.websiteLastCheckedAt, true))}</span></div>
            </div>
          </div>

          <div class="detail-section">
            <h3>Registrar atividade</h3>
            <form class="form-stack" data-form="activity">
              <div class="form-grid">
                <label class="field">
                  <span>Tipo</span>
                  <select name="type">${ACTIVITY_TYPES.map(([value, label]) => option(value, label, 'note')).join('')}</select>
                </label>
                <label class="field">
                  <span>Próximo passo em (opcional)</span>
                  <input type="datetime-local" name="nextActionAt" />
                </label>
                <label class="field field-full">
                  <span>Próximo passo (opcional)</span>
                  <input type="text" name="nextAction" maxlength="500" placeholder="Ex.: ligar novamente na terça" />
                </label>
                <label class="field field-full">
                  <span>Observação</span>
                  <textarea name="note" required maxlength="4000" rows="3" placeholder="O que aconteceu?"></textarea>
                </label>
              </div>
              <p class="form-error" data-form-error role="alert" hidden></p>
              <div><button class="btn btn-primary btn-sm" type="submit">Registrar atividade</button></div>
            </form>
          </div>

          <div class="detail-section">
            <h3>Histórico (${fmtNumber(lead.activities?.length ?? 0)})</h3>
            <ul class="timeline">${activities}</ul>
          </div>
        </div>

        <aside>
          <div class="score-box">
            <div class="score-ring" style="--score:${score}"><strong>${score}</strong></div>
            <div>
              <h3>Score explicável</h3>
              <p class="small muted">${lead.scoreOverride !== null ? `Manual: ${lead.scoreOverride}. Automático: ${lead.score}.` : 'Calculado a partir dos sinais públicos do negócio.'}</p>
            </div>
          </div>

          <div class="detail-section">
            <h3>Critérios considerados</h3>
            ${scoreReasonList(lead.scoreReasons)}
          </div>

          <div class="detail-section">
            <h3>Contatos coletados</h3>
            ${contactsMarkup(lead)}
          </div>

          <div class="detail-section">
            <h3>Origens dos dados</h3>
            <div class="search-history">${sources}</div>
          </div>

          <div class="detail-section">
            <h3>Detalhes técnicos</h3>
            <dl class="kv small">
              <dt>Criado em</dt><dd>${esc(fmtDate(lead.createdAt, true))}</dd>
              <dt>Atualizado em</dt><dd>${esc(fmtDate(lead.updatedAt, true))}</dd>
              <dt>Status HTTP</dt><dd>${esc(lead.websiteHttpStatus ?? '—')}</dd>
              <dt>HTTPS</dt><dd>${lead.siteHasHttps === null ? '—' : lead.siteHasHttps ? 'Sim' : 'Não'}</dd>
              <dt>Tempo de resposta</dt><dd>${lead.siteResponseMs === null ? '—' : `${fmtNumber(lead.siteResponseMs)} ms`}</dd>
              <dt>Redirecionamentos</dt><dd>${esc(lead.redirectCount ?? '—')}</dd>
            </dl>
          </div>
        </aside>
      </div>
    </div>`;
}

export function renderLeadModal() {
  if (!state.modalLead) return;
  dom.modal.innerHTML = `
    <div class="modal-backdrop" data-modal-backdrop>
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="lead-modal-title">
        ${leadModalMarkup(state.modalLead)}
      </div>
    </div>`;
  document.body.style.overflow = 'hidden';
}

async function runLeadOperation(op) {
  const lead = state.modalLead;
  if (!lead || state.modalBusy) return;
  state.modalBusy = true;
  renderLeadModal();
  try {
    if (op === 'verify') {
      const result = await api(`/api/leads/${encodeURIComponent(lead.id)}/verify-site`, { method: 'POST' });
      const verification = result.verification;
      toast(
        verification.reachable
          ? `Site acessível: HTTP ${verification.statusCode}, ${fmtNumber(verification.responseTimeMs)} ms.`
          : `Site indisponível: ${verification.errorMessage || `HTTP ${verification.statusCode}`}.`,
        verification.reachable ? 'success' : 'warning',
      );
    } else if (op === 'enrich') {
      const result = await api(`/api/leads/${encodeURIComponent(lead.id)}/enrich`, { method: 'POST' });
      if (result.skipped) toast(result.reason, 'warning');
      else
        toast(
          `Enriquecimento concluído: ${result.collected.emails} e-mail(s), ${result.collected.phones} telefone(s).`,
          'success',
        );
    } else if (op === 'score') {
      await api(`/api/leads/${encodeURIComponent(lead.id)}/score`, { method: 'POST' });
      toast('Score recalculado com os critérios atuais.', 'success');
    } else if (op === 'dnc') {
      const next = !lead.doNotContact;
      if (
        next &&
        !window.confirm(
          'Marcar este lead como não contatar? Contatos e reuniões serão bloqueados até a remoção.',
        )
      ) {
        state.modalBusy = false;
        renderLeadModal();
        return;
      }
      await api(`/api/leads/${encodeURIComponent(lead.id)}`, {
        method: 'PATCH',
        body: next ? { doNotContact: true, status: 'nao_contatar' } : { doNotContact: false, status: 'novo' },
      });
      toast(
        next ? 'Lead marcado como não contatar.' : 'Preferência de não contato removida.',
        next ? 'warning' : 'success',
      );
    }
    await reloadLeadModal();
    window.dispatchEvent(new CustomEvent('leads:changed'));
  } catch (error) {
    toast(errorMessage(error), 'error');
  } finally {
    state.modalBusy = false;
    if (state.modalLead) renderLeadModal();
  }
}

async function copyValue(value) {
  try {
    await navigator.clipboard.writeText(value);
    toast('Valor copiado.', 'success', 2500);
  } catch {
    const input = document.createElement('textarea');
    input.value = value;
    input.style.position = 'fixed';
    input.style.opacity = '0';
    document.body.appendChild(input);
    input.select();
    document.execCommand('copy');
    input.remove();
    toast('Valor copiado.', 'success', 2500);
  }
}

export function handleLeadModalClick(element) {
  const action = element.dataset.action;
  if (action === 'close-modal') {
    return false;
  }
  if (action === 'edit-lead') {
    state.modalEditing = true;
    renderLeadModal();
    return true;
  }
  if (action === 'cancel-edit') {
    state.modalEditing = false;
    renderLeadModal();
    return true;
  }
  if (action === 'lead-op') {
    void runLeadOperation(element.dataset.op);
    return true;
  }
  if (action === 'copy-value') {
    void copyValue(element.dataset.copy ?? '');
    return true;
  }
  return false;
}

export async function handleLeadModalSubmit(form) {
  const kind = form.dataset.form;
  clearFormMessages(form);

  if (kind === 'lead-edit') {
    if (!state.modalLead) return;
    const data = Object.fromEntries(new FormData(form).entries());
    const body = {
      name: data.name,
      segment: data.segment,
      city: data.city,
      state: data.state,
      country: data.country,
      address: data.address,
      phone: data.phone,
      email: data.email,
      website: data.website,
      scoreOverride: String(data.scoreOverride ?? '').trim() === '' ? null : Number(data.scoreOverride),
    };
    if (data.status) body.status = data.status;
    if (data.note) body.note = data.note;
    setFormBusy(form, true, 'Salvando...');
    try {
      await api(`/api/leads/${encodeURIComponent(state.modalLead.id)}`, { method: 'PATCH', body });
      state.modalEditing = false;
      toast('Lead atualizado.', 'success');
      await reloadLeadModal();
      window.dispatchEvent(new CustomEvent('leads:changed'));
    } catch (error) {
      showFormError(form, errorMessage(error));
      setFormBusy(form, false);
    }
    return;
  }

  if (kind === 'activity') {
    if (!state.modalLead) return;
    const data = Object.fromEntries(new FormData(form).entries());
    if (!String(data.note ?? '').trim()) {
      showFormError(form, 'Informe a observação da atividade.');
      return;
    }
    const nextActionAt = data.nextActionAt ? new Date(String(data.nextActionAt)) : null;
    if (nextActionAt && Number.isNaN(nextActionAt.getTime())) {
      showFormError(form, 'Data do próximo passo inválida.');
      return;
    }
    setFormBusy(form, true, 'Registrando...');
    try {
      await api(`/api/leads/${encodeURIComponent(state.modalLead.id)}/activities`, {
        method: 'POST',
        body: {
          type: data.type,
          note: data.note,
          nextAction: data.nextAction || undefined,
          nextActionAt: nextActionAt ? nextActionAt.toISOString() : undefined,
        },
      });
      toast('Atividade registrada.', 'success');
      await reloadLeadModal();
      window.dispatchEvent(new CustomEvent('leads:changed'));
    } catch (error) {
      showFormError(form, errorMessage(error));
      setFormBusy(form, false);
    }
  }
}
