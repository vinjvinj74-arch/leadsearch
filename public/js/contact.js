(function () {
  'use strict';

  const form = document.getElementById('contact-form');
  const feedback = document.getElementById('contact-feedback');
  if (!form || !feedback) return;

  const submit = form.querySelector('button[type="submit"]');

  function setFeedback(message, kind) {
    feedback.textContent = message;
    feedback.className = `contact-feedback ${kind || ''}`.trim();
  }

  async function csrfToken() {
    const response = await fetch('/api/auth/csrf', {
      credentials: 'same-origin',
      headers: { Accept: 'application/json' },
    });
    if (!response.ok) throw new Error('Não foi possível iniciar o formulário.');
    const data = await response.json();
    if (!data || !data.csrfToken) throw new Error('Não foi possível iniciar o formulário.');
    return data.csrfToken;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const payload = {
      kind: String(data.get('kind') || 'support'),
      name: String(data.get('name') || '').trim(),
      email: String(data.get('email') || '').trim(),
      message: String(data.get('message') || '').trim(),
      acceptPrivacy: data.get('acceptPrivacy') === 'on',
    };

    if (!payload.acceptPrivacy) {
      setFeedback('É necessário aceitar a Política de Privacidade.', 'error');
      return;
    }

    if (submit) submit.disabled = true;
    setFeedback('Enviando solicitação...', 'pending');

    try {
      const token = await csrfToken();
      const response = await fetch('/api/contact', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': token,
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      });
      const result = await response.json().catch(() => ({}));

      if (!response.ok) {
        const message =
          (result && result.error && result.error.message) ||
          'Não foi possível enviar a solicitação. Tente novamente.';
        throw new Error(message);
      }

      form.reset();
      setFeedback(
        `Solicitação registrada. Seu protocolo é ${result.reference}. Guarde o código e acompanhe a resposta pelo e-mail informado.`,
        'success',
      );
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : 'Falha ao enviar a solicitação.', 'error');
    } finally {
      if (submit) submit.disabled = false;
    }
  });
})();
