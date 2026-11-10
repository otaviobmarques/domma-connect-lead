// Motor de envio do Domma Connect Lead (roda no app do PC ou com `npm run engine`).
// Mantém as conexões por QR Code (WhatsApp Web) e faz os envios que o servidor entrega a cada ciclo.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { QrDriver } from './qr-driver.js';

const TICK_MS = 2000;

export class Engine {
  /**
   * @param {object} o
   * @param {string} o.baseUrl   URL do site (ex.: https://connect.domma.com.br)
   * @param {() => string|null} o.getToken  token de login (cookie cl_token)
   * @param {string} o.dataDir   pasta para as sessões do WhatsApp
   * @param {string} [o.version]
   * @param {(s: object) => void} [o.onStatus]  avisa a interface (online, conexões, último erro)
   */
  constructor(o) {
    this.baseUrl = o.baseUrl.replace(/\/$/, '');
    this.getToken = o.getToken;
    this.dataDir = o.dataDir;
    this.version = o.version || '1.0.0';
    this.onStatusCb = o.onStatus || (() => {});
    fs.mkdirSync(this.dataDir, { recursive: true });
    const idFile = path.join(this.dataDir, 'engine-id');
    this.id = fs.existsSync(idFile) ? fs.readFileSync(idFile, 'utf8').trim() : (() => { const v = crypto.randomUUID(); fs.writeFileSync(idFile, v); return v; })();
    this.name = os.hostname().slice(0, 60);
    this.drivers = new Map(); // connection id -> QrDriver
    this.events = [];
    this.running = false; this.timer = null; this.busy = false;
    this.state = { online: false, logged: false, error: null, connections: [], sent: 0, latest_version: null };
  }

  async api(p, body) {
    const token = this.getToken();
    if (!token) { const e = new Error('Faça login no painel'); e.code = 'NOAUTH'; throw e; }
    const r = await fetch(this.baseUrl + p, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(90_000),
    });
    if (r.status === 401) { const e = new Error('Faça login no painel'); e.code = 'NOAUTH'; throw e; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `Servidor respondeu ${r.status}`);
    return r;
  }

  hooks = {
    onState: () => this.kick(),
    onStatus: (wa_id, status, error) => { this.events.push({ type: 'status', wa_id, status, error }); this.kick(); },
    onIncoming: (connection_id, phone, text) => { this.events.push({ type: 'incoming', connection_id, phone, text }); this.kick(); },
  };

  /** baixa a mídia da campanha em pedaços */
  async download(fileId) {
    const parts = [];
    let total = 1;
    for (let i = 0; i < total; i++) {
      const r = await this.api(`/api/files/${encodeURIComponent(fileId)}/chunk/${i}`);
      total = Number(r.headers.get('x-file-chunks')) || 1;
      parts.push(Buffer.from(await r.arrayBuffer()));
    }
    return Buffer.concat(parts);
  }

  start() {
    if (this.running) return;
    this.running = true;
    (async () => { while (this.running) { await this.cycle(); await this.wait(TICK_MS); } })();
  }
  wait(ms) { return new Promise(r => { this._wake = r; this.timer = setTimeout(r, ms); }); }
  /** antecipa o próximo ciclo (ex.: apareceu um QR Code novo) */
  kick() { const w = this._wake; if (w) { this._wake = null; clearTimeout(this.timer); setTimeout(w, 200); } }

  async stop() {
    this.running = false; this.kick();
    for (const d of this.drivers.values()) await d.stop().catch(() => {});
    this.drivers.clear();
  }

  report() {
    return [...this.drivers.entries()].map(([id, d]) => ({ id, status: d.status, phone: d.phone, qr: d.status === 'aguardando_qr' ? d.qr : null, error: d.error }));
  }

  async cycle() {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.events.length) {
        const evs = this.events.splice(0, 500);
        try { await this.api('/api/engine/events', { engine_id: this.id, events: evs }); }
        catch (e) { this.events.unshift(...evs); throw e; }
      }
      const r = await (await this.api('/api/engine/tick', { engine_id: this.id, name: this.name, version: this.version, connections: this.report() })).json();
      this.state.latest_version = r.latest_version || null;
      await this.syncConnections(r.connections || []);
      for (const job of r.jobs || []) await this.runJob(job);
      Object.assign(this.state, { online: true, logged: true, error: null });
    } catch (e) {
      Object.assign(this.state, { online: false, logged: e.code === 'NOAUTH' ? false : this.state.logged, error: e.message });
    } finally {
      this.busy = false;
      this.state.connections = this.report().map(c => ({ ...c, qr: !!c.qr }));
      this.onStatusCb({ ...this.state });
    }
  }

  async syncConnections(list) {
    const wanted = new Map(list.map(c => [c.id, c.want]));
    for (const [id, want] of wanted) {
      const d = this.drivers.get(id);
      if (want === 'on' && !d) {
        const nd = new QrDriver({ id }, this.hooks, this.dataDir);
        this.drivers.set(id, nd);
        nd.start().catch(e => { nd.status = 'erro'; nd.error = e.message; });
      } else if (want === 'logout') {
        if (d) { await d.logout().catch(() => {}); }
        else fs.rmSync(path.join(this.dataDir, 'auth', `conn-${id}`), { recursive: true, force: true });
        const gone = new QrDriver({ id }, this.hooks, this.dataDir); // informa "desconectado" no próximo ciclo
        gone.status = 'desconectado';
        this.drivers.set(id, gone);
      } else if (want === 'off' && d && d.status !== 'desconectado') {
        await d.stop().catch(() => {}); d.status = 'desconectado';
      }
    }
    for (const [id, d] of this.drivers) if (!wanted.has(id)) { await d.stop().catch(() => {}); this.drivers.delete(id); }
  }

  async runJob(job) {
    const d = this.drivers.get(job.connection_id);
    const res = { engine_id: this.id, message_id: job.message_id };
    try {
      if (!d) { const e = new Error('WhatsApp desconectado'); e.code = 'DISCONNECTED'; throw e; }
      const p = job.payload;
      if (p.media) { const id = p.media.fileId; p.media.load = () => this.download(id); }
      const r = await d.send(p);
      Object.assign(res, { ok: true, wa_id: r.id });
      this.state.sent++;
    } catch (e) {
      Object.assign(res, { ok: false, error: e.message, code: e.code });
    }
    for (let i = 0; i < 5; i++) {
      try { await this.api('/api/engine/result', res); return; }
      catch (e) { if (e.code === 'NOAUTH') return; await new Promise(r => setTimeout(r, 2000 * (i + 1))); }
    }
  }
}
