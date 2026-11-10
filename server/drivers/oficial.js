// API Oficial do WhatsApp (Meta Cloud API)
const GRAPH = 'https://graph.facebook.com';

export class OficialDriver {
  constructor(conn, hooks) {
    this.conn = conn; this.hooks = hooks; this.status = 'desconectado'; this.qr = null;
    this.cfg = conn.config || {};
    this.version = this.cfg.api_version || 'v21.0';
    this.mediaCache = this.cfg.media_cache || {}; // fileId -> { id, at }  (ids de mídia da Meta valem 30 dias)
    this.cacheChanged = false;
  }

  async api(path, opts = {}) {
    const res = await fetch(`${GRAPH}/${this.version}/${path}`, {
      ...opts,
      headers: { Authorization: `Bearer ${this.cfg.access_token}`, ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...(opts.headers || {}) },
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      const err = new Error(json.error?.error_user_msg || json.error?.message || `Erro HTTP ${res.status}`);
      err.metaCode = json.error?.code;
      throw err;
    }
    return json;
  }

  async start() {
    if (!this.cfg.phone_number_id || !this.cfg.access_token) {
      await this.hooks.onState(this.conn.id, { status: 'erro', error: 'Preencha o ID do número e o token de acesso' });
      return;
    }
    try {
      const info = await this.api(`${this.cfg.phone_number_id}?fields=display_phone_number,verified_name,quality_rating`);
      this.status = 'conectado';
      await this.hooks.onState(this.conn.id, {
        status: 'conectado',
        phone: String(info.display_phone_number || '').replace(/\D/g, ''),
        meta: { verified_name: info.verified_name, quality_rating: info.quality_rating },
      });
    } catch (e) {
      this.status = 'erro';
      await this.hooks.onState(this.conn.id, { status: 'erro', error: e.message });
    }
  }
  async stop() {}
  async logout() {}

  async templates() {
    if (!this.cfg.waba_id) throw new Error('Informe o ID da conta do WhatsApp Business (WABA) para listar os modelos');
    const out = [];
    let path = `${this.cfg.waba_id}/message_templates?fields=name,language,status,category,components&limit=200`;
    while (path) {
      const j = await this.api(path);
      out.push(...(j.data || []));
      path = j.paging?.next ? j.paging.next.replace(/^https:\/\/graph\.facebook\.com\/v[\d.]+\//, '') : null;
    }
    return out.filter(t => t.status === 'APPROVED');
  }

  async uploadMedia(media) {
    const fd = new FormData();
    fd.append('messaging_product', 'whatsapp');
    fd.append('type', media.mime);
    fd.append('file', new Blob([await media.load()], { type: media.mime }), media.name);
    const j = await this.api(`${this.cfg.phone_number_id}/media`, { method: 'POST', body: fd });
    return j.id;
  }
  async mediaId(media) {
    const c = this.mediaCache[media.fileId];
    if (c && Date.now() - c.at < 20 * 864e5) return c.id;
    const id = await this.uploadMedia(media);
    this.mediaCache[media.fileId] = { id, at: Date.now() };
    this.cacheChanged = true;
    return id;
  }

  async send({ phone, text, media, template }) {
    let body;
    if (template) {
      const components = [];
      if (template.header) {
        const h = template.header;
        if (h.type === 'text') components.push({ type: 'header', parameters: [{ type: 'text', text: h.value }] });
        else if (h.media) {
          const id = await this.mediaId(h.media);
          components.push({ type: 'header', parameters: [{ type: h.type, [h.type]: { id, ...(h.type === 'document' ? { filename: h.name } : {}) } }] });
        }
      }
      if (template.body?.length) components.push({ type: 'body', parameters: template.body.map(v => ({ type: 'text', text: String(v || '-') })) });
      body = { messaging_product: 'whatsapp', to: phone, type: 'template', template: { name: template.name, language: { code: template.lang }, components } };
    } else if (media) {
      const id = await this.mediaId(media);
      const t = media.kind; // image | video | document | audio
      body = { messaging_product: 'whatsapp', to: phone, type: t, [t]: { id, ...(t !== 'audio' && text ? { caption: text } : {}), ...(t === 'document' ? { filename: media.name } : {}) } };
    } else {
      body = { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text, preview_url: true } };
    }
    try {
      const j = await this.api(`${this.cfg.phone_number_id}/messages`, { method: 'POST', body: JSON.stringify(body) });
      return { id: j.messages?.[0]?.id };
    } catch (e) {
      if ([130429, 131048, 131056, 4, 80007].includes(e.metaCode)) e.code = 'TEMP';
      if (e.metaCode === 131026) { e.code = 'NO_WHATSAPP'; e.message = 'Número não tem WhatsApp ou não pode receber'; }
      if (e.metaCode === 131047) e.message = 'Fora da janela de 24h: use um modelo (template) aprovado';
      throw e;
    }
  }

  // Chamado pelo webhook
  async handleWebhookValue(value) {
    for (const s of value.statuses || []) {
      const map = { sent: 'enviado', delivered: 'entregue', read: 'lido', failed: 'falhou' };
      await this.hooks.onStatus(s.id, map[s.status] || s.status, s.errors?.[0]?.title);
    }
    for (const m of value.messages || []) {
      const text = m.text?.body || m.button?.text || m.interactive?.button_reply?.title || '';
      await this.hooks.onIncoming(this.conn.id, m.from, text);
    }
  }
}
