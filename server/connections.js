import { db, now, parseJSON } from './db.js';
import { SimuladoDriver } from './drivers/simulado.js';
import { OficialDriver } from './drivers/oficial.js';
import { QrDriver } from './drivers/qrcode.js';

const drivers = new Map(); // connection id -> driver
const OPTOUT_WORDS = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|remover|n[aã]o quero( mais)?)\s*[.!]*\s*$/i;

const hooks = {
  onState(id, { status, phone, error, meta }) {
    const conn = db.prepare('SELECT * FROM connections WHERE id=?').get(id);
    if (!conn) return;
    const cfg = parseJSON(conn.config_json, {});
    cfg.last_error = error || null;
    if (meta) cfg.meta = meta;
    db.prepare('UPDATE connections SET status=?, phone=COALESCE(?, phone), config_json=? WHERE id=?')
      .run(status, phone || null, JSON.stringify(cfg), id);
  },
  onStatus(waId, status, error) {
    if (!waId) return;
    const order = { enviado: 1, entregue: 2, lido: 3 };
    const msg = db.prepare('SELECT id, status FROM messages WHERE wa_message_id=?').get(waId);
    if (!msg) return;
    if (status === 'falhou') {
      db.prepare("UPDATE messages SET status='falhou', error=?, updated_at=? WHERE id=?").run(error || 'Falha na entrega', now(), msg.id);
    } else if ((order[status] || 0) > (order[msg.status] || 0)) {
      db.prepare('UPDATE messages SET status=?, updated_at=? WHERE id=?').run(status, now(), msg.id);
    }
  },
  onIncoming(connId, phone, text) {
    const conn = db.prepare('SELECT workspace_id FROM connections WHERE id=?').get(connId);
    if (!conn) return;
    const last = db.prepare(`SELECT m.id FROM messages m JOIN campaigns c ON c.id=m.campaign_id
      WHERE c.connection_id=? AND m.phone=? AND m.sent_at IS NOT NULL ORDER BY m.id DESC LIMIT 1`).get(connId, phone);
    if (last) db.prepare('UPDATE messages SET replied=1, reply_text=COALESCE(reply_text, ?) WHERE id=?').run(String(text || '').slice(0, 500), last.id);
    if (OPTOUT_WORDS.test(text || '')) {
      db.prepare('INSERT OR IGNORE INTO optouts (workspace_id, phone, reason) VALUES (?,?,?)').run(conn.workspace_id, phone, `Respondeu "${text.trim()}"`);
    }
  },
};

export function rowToConn(row) {
  return row && { ...row, config: parseJSON(row.config_json, {}) };
}

function makeDriver(conn) {
  if (conn.type === 'simulado') return new SimuladoDriver(conn, hooks);
  if (conn.type === 'oficial') return new OficialDriver(conn, hooks);
  return new QrDriver(conn, hooks);
}

export async function startConnection(id) {
  const conn = rowToConn(db.prepare('SELECT * FROM connections WHERE id=?').get(id));
  if (!conn) throw new Error('Conexão não encontrada');
  await stopConnection(id);
  const d = makeDriver(conn);
  drivers.set(id, d);
  await d.start();
  return d;
}

export async function stopConnection(id) {
  const d = drivers.get(id);
  if (d) { await d.stop(); drivers.delete(id); }
}

export async function logoutConnection(id) {
  const d = drivers.get(id);
  if (d) { await d.logout(); drivers.delete(id); }
  hooks.onState(id, { status: 'desconectado' });
}

export function getDriver(id) { return drivers.get(id); }

export async function bootConnections() {
  const rows = db.prepare("SELECT id, type, status FROM connections").all();
  for (const r of rows) {
    if (r.type === 'qr' && !['conectado', 'reconectando'].includes(r.status)) continue;
    startConnection(r.id).catch(e => console.error('Falha ao iniciar conexão', r.id, e.message));
  }
}

export function handleMetaWebhook(body) {
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      const pnid = ch.value?.metadata?.phone_number_id;
      if (!pnid) continue;
      for (const [, d] of drivers) {
        if (d instanceof OficialDriver && String(d.cfg.phone_number_id) === String(pnid)) d.handleWebhookValue(ch.value);
      }
    }
  }
}

export { hooks };
