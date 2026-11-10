// Conexões. No servidor (Vercel) não há estado em memória: API Oficial e conexão de teste são
// chamadas sob demanda; o QR Code é mantido pelo app do PC (motor de envio), que avisa por /api/engine/*.
import { db, now, parseJSON } from './db.js';
import { SimuladoDriver } from './drivers/simulado.js';
import { OficialDriver } from './drivers/oficial.js';

const OPTOUT_WORDS = /^\s*(sair|parar|pare|stop|cancelar|descadastrar|remover|n[aã]o quero( mais)?)\s*[.!]*\s*$/i;
export const ENGINE_ONLINE_MS = 30_000;

export const hooks = {
  async onState(id, { status, phone, error, meta, qr }) {
    const conn = await db.get('SELECT * FROM connections WHERE id=?', [id]);
    if (!conn) return;
    const cfg = parseJSON(conn.config_json, {});
    cfg.last_error = error || null;
    if (meta) cfg.meta = meta;
    await db.run('UPDATE connections SET status=?, phone=COALESCE(?, phone), config_json=?, qr=? WHERE id=?',
      [status, phone || null, JSON.stringify(cfg), status === 'aguardando_qr' ? (qr || conn.qr) : null, id]);
  },
  async onStatus(waId, status, error) {
    if (!waId) return;
    const order = { enviado: 1, entregue: 2, lido: 3 };
    const msg = await db.get('SELECT id, status FROM messages WHERE wa_message_id=?', [waId]);
    if (!msg) return;
    if (status === 'falhou') {
      await db.run("UPDATE messages SET status='falhou', error=?, updated_at=? WHERE id=?", [error || 'Falha na entrega', now(), msg.id]);
    } else if ((order[status] || 0) > (order[msg.status] || 0)) {
      await db.run('UPDATE messages SET status=?, updated_at=? WHERE id=?', [status, now(), msg.id]);
    }
  },
  async onIncoming(connId, phone, text) {
    const conn = await db.get('SELECT workspace_id FROM connections WHERE id=?', [connId]);
    if (!conn) return;
    const last = await db.get(`SELECT m.id FROM messages m JOIN campaigns c ON c.id=m.campaign_id
      WHERE c.connection_id=? AND m.phone=? AND m.sent_at IS NOT NULL ORDER BY m.id DESC LIMIT 1`, [connId, phone]);
    if (last) await db.run('UPDATE messages SET replied=1, reply_text=COALESCE(reply_text, ?) WHERE id=?', [String(text || '').slice(0, 500), last.id]);
    if (OPTOUT_WORDS.test(text || '')) {
      await db.run('INSERT INTO optouts (workspace_id, phone, reason) VALUES (?,?,?) ON CONFLICT DO NOTHING', [conn.workspace_id, phone, `Respondeu "${text.trim()}"`]);
    }
  },
};

export function rowToConn(row) {
  return row && { ...row, config: parseJSON(row.config_json, {}) };
}

/** Driver do servidor (só API Oficial e teste). QR Code roda no app do PC. */
export function serverDriver(row) {
  const conn = rowToConn(row);
  if (conn.type === 'simulado') return new SimuladoDriver(conn, hooks);
  if (conn.type === 'oficial') return new OficialDriver(conn, hooks);
  return null;
}

/** Guarda o cache de mídias da Meta (para não reenviar o mesmo arquivo a cada mensagem) */
export async function saveDriverCache(connId, driver) {
  if (!(driver instanceof OficialDriver) || !driver.cacheChanged) return;
  const row = await db.get('SELECT config_json FROM connections WHERE id=?', [connId]);
  const cfg = parseJSON(row?.config_json, {});
  cfg.media_cache = driver.mediaCache;
  await db.run('UPDATE connections SET config_json=? WHERE id=?', [JSON.stringify(cfg), connId]);
  driver.cacheChanged = false;
}

/** Testa / ativa uma conexão do servidor (API Oficial ou teste). QR Code: só registra o pedido. */
export async function startConnection(id) {
  const row = await db.get('SELECT * FROM connections WHERE id=?', [id]);
  if (!row) throw new Error('Conexão não encontrada');
  if (row.type === 'qr') {
    await db.run("UPDATE connections SET want='on' WHERE id=?", [id]);
    return null;
  }
  const d = serverDriver(row);
  await d.start();
  return d;
}

export async function logoutConnection(id) {
  const row = await db.get('SELECT * FROM connections WHERE id=?', [id]);
  if (!row) return;
  if (row.type === 'qr') {
    // o app do PC faz o logout no próximo ciclo e libera a conexão para qualquer computador
    await db.run("UPDATE connections SET want='logout', qr=NULL WHERE id=?", [id]);
    if (!engineOnline(row)) await db.run("UPDATE connections SET status='desconectado', engine_id=NULL WHERE id=?", [id]);
    return;
  }
  await hooks.onState(id, { status: 'desconectado' });
}

export const engineOnline = conn => Date.now() - Number(conn.engine_seen_at || 0) < ENGINE_ONLINE_MS;

export async function handleMetaWebhook(body) {
  const conns = await db.all("SELECT * FROM connections WHERE type='oficial' AND workspace_id > 0");
  for (const entry of body.entry || []) {
    for (const ch of entry.changes || []) {
      const pnid = ch.value?.metadata?.phone_number_id;
      if (!pnid) continue;
      for (const row of conns) {
        if (String(parseJSON(row.config_json, {}).phone_number_id) !== String(pnid)) continue;
        await serverDriver(row).handleWebhookValue(ch.value);
      }
    }
  }
}
