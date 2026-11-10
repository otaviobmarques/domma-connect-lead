// Fila de envio sem processo fixo: avança a cada "ciclo" (tick).
// Os ciclos vêm do app do PC (motor de envio, a cada 2 s) e do painel aberto no navegador.
// - API Oficial e conexão de teste: o próprio servidor envia dentro do ciclo.
// - QR Code: o servidor monta o envio e devolve para o app do PC, que envia e informa o resultado.
// Velocidade, pausas, horário permitido, limite diário, IA e descadastro valem para todos.
import { db, now, parseJSON } from './db.js';
import { serverDriver, saveDriverCache, engineOnline, hooks } from './connections.js';
import { renderMessage, renderVars } from './render.js';
import { firstName } from './spreadsheet.js';
import { personalize } from './ai.js';
import { getSettings } from './settings.js';
import { readFile } from './files.js';

export const SPEEDS = {
  qr: {
    segura: { min: 30, max: 75, every: [15, 25], pause: [180, 360], label: 'Segura' },
    normal: { min: 15, max: 35, every: [30, 40], pause: [120, 240], label: 'Normal' },
    rapida: { min: 6, max: 14, every: [45, 60], pause: [60, 120], label: 'Rápida' },
  },
  oficial: {
    segura: { min: 2, max: 4, label: 'Segura' },
    normal: { min: 0.8, max: 1.5, label: 'Normal' },
    rapida: { min: 0.2, max: 0.4, label: 'Rápida' },
  },
};
SPEEDS.simulado = { segura: { min: 3, max: 6, every: [10, 12], pause: [10, 15], label: 'Segura' }, normal: { min: 1.5, max: 3, label: 'Normal' }, rapida: { min: 0.5, max: 1, label: 'Rápida' } };

const rand = (a, b) => a + Math.random() * (b - a);
const sleep = ms => new Promise(r => setTimeout(r, ms));
const LEASE_MS = 3 * 60_000;      // tempo que o app do PC tem para enviar uma mensagem
const SERVER_BUDGET_MS = 8_000;   // quanto tempo cada ciclo pode gastar enviando pelo servidor

export function speedConfig(type, speed, custom = {}) {
  if (speed === 'personalizado') {
    const min = Math.max(1, Number(custom.custom_min) || 20), max = Math.max(min, Number(custom.custom_max) || min);
    const every = Number(custom.custom_every) || 0, pause = Number(custom.custom_pause) || 0;
    return { min, max, ...(every && pause ? { every: [every, every], pause: [pause * 60, pause * 60] } : {}), label: 'Personalizado' };
  }
  return (SPEEDS[type] || SPEEDS.qr)[speed] || (SPEEDS[type] || SPEEDS.qr).segura;
}

export function estimateSeconds(type, speed, count, custom) {
  const s = speedConfig(type, speed, custom);
  let t = count * (s.min + s.max) / 2;
  if (s.every) t += Math.floor(count / ((s.every[0] + s.every[1]) / 2)) * (s.pause[0] + s.pause[1]) / 2;
  return Math.round(t);
}

const WD = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
export function withinBusinessHours(cfg = {}, d = new Date()) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Sao_Paulo', weekday: 'short', hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
  const h = (Number(parts.hour) % 24) + Number(parts.minute) / 60;
  const days = cfg.dias || [1, 2, 3, 4, 5, 6], ini = Number(cfg.horario_inicio ?? 8), fim = Number(cfg.horario_fim ?? 20);
  return days.includes(WD[parts.weekday]) && h >= ini && h < fim;
}
const DIAS = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];
export const hoursLabel = cfg => `${(cfg.dias || []).map(d => DIAS[d]).join(', ')}, ${cfg.horario_inicio}h às ${cfg.horario_fim}h`;
function startOfTodaySP() {
  const d = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
  return new Date(`${d}T00:00:00-03:00`).toISOString();
}

export function contactVars(contact) {
  const data = parseJSON(contact.data_json, {});
  return {
    ...data,
    nome: contact.name || data.nome || '',
    primeiro_nome: firstName(contact.name || data.nome),
    telefone: contact.phone,
  };
}

/** Gera as mensagens da campanha a partir da lista (chamado ao iniciar) */
export async function prepareCampaign(campaignId) {
  await db.tx(async t => {
    const c = await t.get('SELECT * FROM campaigns WHERE id=? FOR UPDATE', [campaignId]);
    if ((await t.get('SELECT COUNT(*) n FROM messages WHERE campaign_id=?', [campaignId])).n) return;
    // uma única instrução: contatos válidos da lista, já marcando quem pediu para sair
    await t.run(`INSERT INTO messages (campaign_id, contact_id, phone, name, vars_json, status, error)
      SELECT ?, ct.id, ct.phone, ct.name, ct.data_json,
        CASE WHEN o.phone IS NULL THEN 'pendente' ELSE 'ignorado' END,
        CASE WHEN o.phone IS NULL THEN NULL ELSE 'Pediu para não receber (SAIR)' END
      FROM contacts ct LEFT JOIN optouts o ON o.workspace_id=? AND o.phone=ct.phone
      WHERE ct.list_id=? AND ct.status='valido' ORDER BY ct.row_number`, [campaignId, c.workspace_id, c.list_id]);
  });
}
// vars_json guarda os dados brutos do contato; as variáveis (primeiro_nome etc.) são montadas no envio
const msgVars = m => contactVars({ data_json: m.vars_json, name: m.name, phone: m.phone });

/** Conexão de teste: simula "entregue" e "lido" alguns segundos depois do envio */
async function advanceSimulated(ws) {
  const t3 = new Date(Date.now() - 3000).toISOString(), t8 = new Date(Date.now() - 8000).toISOString();
  await db.run(`UPDATE messages m SET status=CASE WHEN m.sent_at < ? AND m.id % 10 < 6 THEN 'lido' ELSE 'entregue' END, updated_at=?
    FROM campaigns c WHERE c.id=m.campaign_id AND c.workspace_id=? AND m.wa_message_id LIKE 'SIM-%'
    AND ((m.status='enviado' AND m.sent_at < ?) OR (m.status='entregue' AND m.sent_at < ? AND m.id % 10 < 6))`, [t8, now(), ws, t3, t8]);
}

/** Monta o envio de uma mensagem: variáveis, spintax, IA, rodapé de descadastro e mídia */
async function buildSend(c, msg, conn, settings) {
  const vars = msgVars(msg);
  const payload = { phone: msg.phone, typing: settings.digitacao };
  let rendered = '', aiNote = null;
  const mediaRef = (file, mime, name) => ({ fileId: file, mime: mime || 'application/octet-stream', name: name || file, load: () => readFile(file) });
  if (c.mode === 'template') {
    const p = parseJSON(c.template_params_json, {});
    payload.template = {
      name: c.template_name, lang: c.template_lang,
      body: (p.body || []).map(v => renderVars(v, vars)),
      header: p.header ? (p.header.type === 'text' ? { type: 'text', value: renderVars(p.header.value, vars) }
        : c.media_file ? { type: p.header.type, media: mediaRef(c.media_file, c.media_type, c.media_name), name: c.media_name } : null) : null,
    };
    rendered = `[Modelo ${c.template_name}] ` + payload.template.body.join(' | ');
  } else {
    rendered = renderMessage(c.message, vars);
    if (c.ai_enabled) {
      try { rendered = await personalize(settings, { base: rendered, instructions: c.ai_instructions, contact: vars }); }
      catch (e) { aiNote = 'IA indisponível, enviada a mensagem base: ' + e.message.slice(0, 120); }
    }
    if (c.add_optout_footer && settings.disparo.rodape_optout && conn.type !== 'oficial') rendered += `\n\n_${settings.disparo.rodape_optout}_`;
    payload.text = rendered;
    if (c.media_file) {
      const mime = c.media_type || 'application/octet-stream';
      payload.media = { ...mediaRef(c.media_file, mime, c.media_name),
        kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document' };
    }
  }
  return { payload, rendered, aiNote };
}

/** Grava o resultado de um envio e agenda o próximo, respeitando velocidade e pausas */
async function finish(campaignId, connType, msg, res) {
  if (res.ok) {
    await db.run("UPDATE messages SET status='enviado', wa_message_id=?, sent_at=?, updated_at=? WHERE id=? AND status='enviando'", [res.wa_id || null, now(), now(), msg.id]);
  } else if (res.code === 'DISCONNECTED') {
    await db.run("UPDATE messages SET status='pendente', attempts=GREATEST(attempts-1,0) WHERE id=?", [msg.id]);
    await db.run("UPDATE campaigns SET status='pausada', pause_reason=?, next_send_at=0 WHERE id=? AND status='enviando'", ['A conexão do WhatsApp caiu. Reconecte e clique em Retomar.', campaignId]);
    return 0;
  } else {
    const retry = res.code === 'TEMP' && msg.attempts < 3;
    await db.run('UPDATE messages SET status=?, error=?, updated_at=? WHERE id=?',
      [retry ? 'pendente' : (res.code === 'NO_WHATSAPP' ? 'sem_whatsapp' : 'falhou'), String(res.error || 'Falha no envio').slice(0, 500), now(), msg.id]);
  }
  const c = await db.get('SELECT * FROM campaigns WHERE id=?', [campaignId]);
  if (!c || c.status !== 'enviando') return 0;
  const sp = speedConfig(connType, c.speed, c);
  let delay = rand(sp.min, sp.max) * 1000, sincePause = c.sent_since_pause + 1, reason = null;
  if (sp.every && sincePause >= rand(sp.every[0], sp.every[1])) {
    const pause = rand(sp.pause[0], sp.pause[1]) * 1000;
    delay += pause; sincePause = 0;
    reason = `Pausa programada (${Math.round(pause / 60000) || 1} min) para proteger seu número`;
  }
  await db.run('UPDATE campaigns SET next_send_at=?, sent_since_pause=?, pause_reason=? WHERE id=?', [Math.round(Date.now() + delay), sincePause, reason, campaignId]);
  return delay;
}

const hold = (id, ms, reason) => db.run('UPDATE campaigns SET next_send_at=?, pause_reason=? WHERE id=?', [Date.now() + ms, reason, id]);

/**
 * Tenta enviar a próxima mensagem de uma campanha (já reservada para este ciclo).
 * Retorna { job } quando o envio deve ser feito pelo app do PC, { delay } quando o servidor já enviou,
 * ou {} quando não há nada a fazer agora.
 */
async function step(c, engine, settingsCache) {
  const conn = await db.get('SELECT * FROM connections WHERE id=?', [c.connection_id]);
  if (!conn || conn.workspace_id <= 0) {
    await db.run("UPDATE campaigns SET status='pausada', pause_reason=? WHERE id=?", ['A conexão desta campanha foi removida.', c.id]);
    return {};
  }
  if (conn.type === 'qr') {
    if (!engineOnline(conn)) { await hold(c.id, 10_000, 'Aguardando o app Domma Connect Lead abrir no computador para continuar os envios'); return {}; }
    if (!engine || conn.engine_id !== engine.id) { await db.run('UPDATE campaigns SET next_send_at=? WHERE id=?', [Date.now() + 1500, c.id]); return {}; }
    if (conn.status !== 'conectado') {
      await db.run("UPDATE campaigns SET status='pausada', pause_reason=? WHERE id=?", ['A conexão do WhatsApp caiu. Reconecte e clique em Retomar.', c.id]);
      return {};
    }
  } else if (conn.status !== 'conectado') {
    await db.run("UPDATE campaigns SET status='pausada', pause_reason=? WHERE id=?", ['A conexão do WhatsApp não está ativa. Teste a conexão e clique em Retomar.', c.id]);
    return {};
  }
  const ws = await db.get('SELECT * FROM workspaces WHERE id=?', [c.workspace_id]);
  const settings = settingsCache[ws.id] ||= await getSettings(ws);
  if (c.business_hours && !withinBusinessHours(settings.disparo)) {
    await hold(c.id, 60_000, `Aguardando o horário permitido (${hoursLabel(settings.disparo)})`);
    return {};
  }
  const limit = Number(settings.disparo.limite_diario) || 0;
  if (limit > 0) {
    const sentToday = (await db.get('SELECT COUNT(*) n FROM messages m JOIN campaigns k ON k.id=m.campaign_id WHERE k.connection_id=? AND m.sent_at >= ?', [c.connection_id, startOfTodaySP()])).n;
    if (sentToday >= limit) {
      await hold(c.id, 5 * 60_000, `Limite diário de ${limit} mensagens deste número atingido — continua amanhã automaticamente`);
      return {};
    }
  }
  const msg = await db.get(`UPDATE messages SET status='enviando', attempts=attempts+1, updated_at=?
    WHERE id=(SELECT id FROM messages WHERE campaign_id=? AND status='pendente' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED) RETURNING *`, [now(), c.id]);
  if (!msg) {
    if (!(await db.get("SELECT 1 FROM messages WHERE campaign_id=? AND status='enviando'", [c.id]))) {
      await db.run("UPDATE campaigns SET status='concluida', finished_at=?, pause_reason=NULL WHERE id=? AND status='enviando'", [now(), c.id]);
    } else await db.run('UPDATE campaigns SET next_send_at=? WHERE id=?', [Date.now() + 3000, c.id]);
    return {};
  }
  // descadastro pode ter chegado durante a campanha
  if (await db.get('SELECT 1 FROM optouts WHERE workspace_id=? AND phone=?', [c.workspace_id, msg.phone])) {
    await db.run("UPDATE messages SET status='ignorado', error='Pediu para não receber (SAIR)', updated_at=? WHERE id=?", [now(), msg.id]);
    await db.run('UPDATE campaigns SET next_send_at=0 WHERE id=?', [c.id]);
    return { delay: 0 };
  }
  const { payload, rendered, aiNote } = await buildSend(c, msg, conn, settings);
  await db.run('UPDATE messages SET rendered=?, error=? WHERE id=?', [rendered, aiNote, msg.id]);

  if (conn.type === 'qr') {
    const strip = m => m && { fileId: m.fileId, mime: m.mime, name: m.name, kind: m.kind };
    return { job: { message_id: msg.id, campaign_id: c.id, connection_id: conn.id, payload: { ...payload, media: strip(payload.media) } } };
  }
  const driver = serverDriver(conn);
  let res;
  try { const r = await driver.send(payload); res = { ok: true, wa_id: r.id }; }
  catch (e) { res = { ok: false, error: e.message, code: e.code }; }
  await saveDriverCache(conn.id, driver).catch(() => {});
  return { delay: await finish(c.id, conn.type, msg, res) };
}

/**
 * Um ciclo da fila para uma empresa.
 * engine = { id, name, version, user_id, connections: [{ id, status, phone, qr, error }] } quando vem do app do PC.
 */
export async function tick(wsId, engine = null) {
  const t0 = Date.now();
  const jobs = [];
  let qrConnections = [];
  if (engine) {
    await db.run(`INSERT INTO engines (id, workspace_id, user_id, name, version, last_seen) VALUES (?,?,?,?,?,?)
      ON CONFLICT (id) DO UPDATE SET workspace_id=EXCLUDED.workspace_id, user_id=EXCLUDED.user_id, name=EXCLUDED.name, version=EXCLUDED.version, last_seen=EXCLUDED.last_seen`,
      [engine.id, wsId, engine.user_id || null, String(engine.name || '').slice(0, 80), String(engine.version || '').slice(0, 20), Date.now()]);
    // conexões QR desta empresa: as sem dono ficam com este computador
    await db.run(`UPDATE connections SET engine_id=? WHERE workspace_id=? AND type='qr' AND engine_id IS NULL AND want='on'`, [engine.id, wsId]);
    for (const r of engine.connections || []) {
      const row = await db.get("SELECT * FROM connections WHERE id=? AND workspace_id=? AND type='qr' AND engine_id=?", [r.id, wsId, engine.id]);
      if (!row) continue;
      await db.run('UPDATE connections SET engine_seen_at=? WHERE id=?', [Date.now(), row.id]);
      if (r.status && (r.status !== row.status || (r.qr || null) !== (row.qr || null) || (r.phone && r.phone !== row.phone))) {
        await hooks.onState(row.id, { status: r.status, phone: r.phone, error: r.error, qr: r.qr });
      }
    }
    qrConnections = (await db.all("SELECT id, want FROM connections WHERE workspace_id IN (?, ?) AND type='qr' AND engine_id=?", [wsId, -wsId, engine.id]))
      .map(q => ({ id: q.id, want: q.want }));
    // pedido de desconexão concluído: libera a conexão
    for (const q of qrConnections.filter(q => q.want === 'logout')) {
      const rep = (engine.connections || []).find(r => r.id === q.id);
      if (rep && rep.status === 'desconectado') await db.run("UPDATE connections SET want='off', engine_id=NULL, status='desconectado', qr=NULL WHERE id=?", [q.id]);
    }
  }

  // agendadas que chegaram na hora
  const due = await db.all("SELECT id FROM campaigns WHERE workspace_id=? AND status='agendada' AND scheduled_at <= ?", [wsId, now()]);
  for (const c of due) {
    await prepareCampaign(c.id);
    await db.run("UPDATE campaigns SET status='enviando', started_at=COALESCE(started_at, ?), next_send_at=0 WHERE id=?", [now(), c.id]);
  }
  await advanceSimulated(wsId);
  // mensagens presas em "enviando" (o app do PC fechou no meio do envio) voltam para a fila
  await db.run(`UPDATE messages m SET status='pendente' FROM campaigns c WHERE c.id=m.campaign_id AND c.workspace_id=? AND m.status='enviando' AND m.updated_at < ?`,
    [wsId, new Date(Date.now() - LEASE_MS - 30_000).toISOString()]);

  const settingsCache = {};
  const active = await db.all("SELECT id FROM campaigns WHERE workspace_id=? AND status='enviando' AND next_send_at <= ? ORDER BY id", [wsId, Date.now()]);
  await Promise.all(active.map(async ({ id }) => {
    // reserva a campanha para este ciclo (evita envio duplo quando painel e app rodam juntos)
    for (;;) {
      const c = await db.get("UPDATE campaigns SET next_send_at=? WHERE id=? AND status='enviando' AND next_send_at <= ? RETURNING *", [Date.now() + LEASE_MS, id, Date.now()]);
      if (!c) return;
      let r;
      try { r = await step(c, engine, settingsCache); }
      catch (e) { console.error('Erro na campanha', id, e); await db.run('UPDATE campaigns SET next_send_at=? WHERE id=?', [Date.now() + 10_000, id]); return; }
      if (r.job) { jobs.push(r.job); return; }
      if (r.delay == null) return;
      // envio pelo servidor: continua no mesmo ciclo enquanto couber no tempo
      if (Date.now() - t0 + r.delay > SERVER_BUDGET_MS) return;
      await sleep(r.delay);
    }
  }));
  return { jobs, connections: qrConnections };
}

/** Resultado de um envio feito pelo app do PC */
export async function reportResult(wsId, engineId, r) {
  const msg = await db.get(`SELECT m.*, c.connection_id FROM messages m JOIN campaigns c ON c.id=m.campaign_id
    WHERE m.id=? AND c.workspace_id=? AND m.status='enviando'`, [r.message_id, wsId]);
  if (!msg) return { ok: false };
  const conn = await db.get('SELECT type, engine_id FROM connections WHERE id=?', [msg.connection_id]);
  if (conn?.engine_id !== engineId) return { ok: false };
  await finish(msg.campaign_id, conn.type, msg, { ok: !!r.ok, wa_id: r.wa_id, error: r.error, code: r.code });
  return { ok: true };
}
