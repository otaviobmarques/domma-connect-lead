// Conexão por QR Code (WhatsApp Web) via Baileys
import fs from 'node:fs';
import path from 'node:path';
import QRCode from 'qrcode';
import pino from 'pino';
import { makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';

const logger = pino({ level: process.env.BAILEYS_LOG || 'silent' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const phoneFromJid = jid => (jid && jid.endsWith('@s.whatsapp.net')) ? jid.split('@')[0].split(':')[0] : null;

export class QrDriver {
  constructor(conn, hooks, dataDir) {
    this.conn = conn; this.hooks = hooks;
    this.status = 'desconectado'; this.qr = null; this.sock = null; this.stopped = false; this.phone = null; this.error = null;
    this.authDir = path.join(dataDir, 'auth', `conn-${conn.id}`);
  }

  async start() {
    this.stopped = false;
    const { state, saveCreds } = await useMultiFileAuthState(this.authDir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* usa a padrão */ }
    const sock = makeWASocket({
      auth: state, logger, ...(version ? { version } : {}),
      browser: ['Domma Connect Lead', 'Chrome', '1.0.0'],
      markOnlineOnConnect: false, syncFullHistory: false,
    });
    this.sock = sock;
    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('connection.update', async (u) => {
      if (u.qr) {
        this.qr = await QRCode.toDataURL(u.qr, { margin: 1, width: 320 });
        this.status = 'aguardando_qr';
        this.hooks.onState(this.conn.id, { status: 'aguardando_qr' });
      }
      if (u.connection === 'open') {
        this.qr = null; this.status = 'conectado'; this.error = null;
        this.phone = phoneFromJid(sock.user?.id) || sock.user?.id?.split(':')[0];
        this.hooks.onState(this.conn.id, { status: 'conectado', phone: phoneFromJid(sock.user?.id) || sock.user?.id?.split(':')[0] });
      }
      if (u.connection === 'close') {
        const code = u.lastDisconnect?.error?.output?.statusCode;
        this.sock = null;
        if (code === DisconnectReason.loggedOut) {
          fs.rmSync(this.authDir, { recursive: true, force: true });
          this.status = 'desconectado'; this.qr = null; this.error = 'Sessão encerrada no celular';
          this.hooks.onState(this.conn.id, { status: 'desconectado', error: 'Sessão encerrada no celular' });
          return;
        }
        if (!this.stopped) {
          this.status = 'reconectando';
          this.hooks.onState(this.conn.id, { status: 'reconectando' });
          await sleep(code === DisconnectReason.restartRequired ? 500 : 4000);
          if (!this.stopped) this.start().catch(e => { this.status = 'erro'; this.error = e.message; this.hooks.onState(this.conn.id, { status: 'erro', error: e.message }); });
        }
      }
    });
    sock.ev.on('messages.update', (updates) => {
      for (const { key, update } of updates) {
        if (!key.fromMe || update.status === undefined) continue;
        const map = { 2: 'enviado', 3: 'entregue', 4: 'lido', 5: 'lido' };
        if (map[update.status]) this.hooks.onStatus(key.id, map[update.status]);
      }
    });
    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (m.key.fromMe || !m.message) continue;
        const jid = m.key.remoteJid || '';
        if (jid.endsWith('@g.us') || jid === 'status@broadcast') continue;
        const phone = phoneFromJid(jid) || phoneFromJid(m.key.remoteJidAlt) || phoneFromJid(m.key.senderPn);
        const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.buttonsResponseMessage?.selectedDisplayText || '';
        if (phone) this.hooks.onIncoming(this.conn.id, phone, text);
      }
    });
  }

  async stop() { this.stopped = true; try { this.sock?.end(undefined); } catch {} this.sock = null; }
  async logout() {
    this.stopped = true;
    try { await this.sock?.logout(); } catch {}
    fs.rmSync(this.authDir, { recursive: true, force: true });
    this.sock = null; this.status = 'desconectado'; this.qr = null;
  }

  async send({ phone, text, media, typing = { ligado: true, velocidade: 18, min: 1.5, max: 8 } }) {
    if (!this.sock || this.status !== 'conectado') { const e = new Error('WhatsApp desconectado'); e.code = 'DISCONNECTED'; throw e; }
    const [res] = await this.sock.onWhatsApp(phone);
    if (!res?.exists) { const e = new Error('Número não tem WhatsApp'); e.code = 'NO_WHATSAPP'; throw e; }
    const jid = res.jid;
    if (typing?.ligado) {
      try {
        await this.sock.sendPresenceUpdate('composing', jid);
        const secs = Math.min(Number(typing.max) || 8, Math.max(Number(typing.min) || 1, (text?.length || 0) / (Number(typing.velocidade) || 18)));
        await sleep(secs * 1000 * (0.85 + Math.random() * 0.3));
        await this.sock.sendPresenceUpdate('paused', jid);
      } catch {}
    }
    let content;
    if (media) {
      const buf = await media.load();
      if (media.kind === 'image') content = { image: buf, caption: text || undefined };
      else if (media.kind === 'video') content = { video: buf, caption: text || undefined };
      else if (media.kind === 'audio') content = { audio: buf, mimetype: media.mime, ptt: true };
      else content = { document: buf, mimetype: media.mime, fileName: media.name, caption: text || undefined };
    } else content = { text };
    const sent = await this.sock.sendMessage(jid, content);
    if (media?.kind === 'audio' && text) await this.sock.sendMessage(jid, { text });
    return { id: sent?.key?.id };
  }
}
