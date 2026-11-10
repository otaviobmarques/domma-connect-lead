// Fila de envio: processa campanhas respeitando velocidade, pausas e horário comercial
import path from 'node:path';
import { db, now, parseJSON, DATA_DIR } from './db.js';
import { getDriver } from './connections.js';
import { renderMessage, renderVars } from './render.js';
import { firstName } from './spreadsheet.js';
import { personalize } from './ai.js';
import { getSettings } from './settings.js';

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
export function prepareCampaign(campaignId) {
  const c = db.prepare('SELECT * FROM campaigns WHERE id=?').get(campaignId);
  const exists = db.prepare('SELECT COUNT(*) n FROM messages WHERE campaign_id=?').get(campaignId).n;
  if (exists) return;
  const contacts = db.prepare("SELECT * FROM contacts WHERE list_id=? AND status='valido' ORDER BY row_number").all(c.list_id);
  const opt = new Set(db.prepare('SELECT phone FROM optouts WHERE workspace_id=?').all(c.workspace_id).map(r => r.phone));
  const ins = db.prepare('INSERT INTO messages (campaign_id, contact_id, phone, name, vars_json, status, error) VALUES (?,?,?,?,?,?,?)');
  db.transaction(() => {
    for (const ct of contacts) {
      const blocked = opt.has(ct.phone);
      ins.run(campaignId, ct.id, ct.phone, ct.name, JSON.stringify(contactVars(ct)), blocked ? 'ignorado' : 'pendente', blocked ? 'Pediu para não receber (SAIR)' : null);
    }
  })();
}

const busy = new Set();

async function processCampaign(c) {
  if (busy.has(c.id)) return;
  busy.add(c.id);
  try {
    const conn = db.prepare('SELECT * FROM connections WHERE id=?').get(c.connection_id);
    const driver = getDriver(c.connection_id);
    if (!conn || !driver || conn.status !== 'conectado') {
      db.prepare("UPDATE campaigns SET status='pausada', pause_reason=? WHERE id=?").run('A conexão do WhatsApp caiu. Reconecte e clique em Retomar.', c.id);
      return;
    }
    const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(c.workspace_id);
    const settings = getSettings(ws);
    if (c.business_hours && !withinBusinessHours(settings.disparo)) {
      db.prepare('UPDATE campaigns SET next_send_at=?, pause_reason=? WHERE id=?').run(Date.now() + 60_000, `Aguardando o horário permitido (${hoursLabel(settings.disparo)})`, c.id);
      return;
    }
    const limit = Number(settings.disparo.limite_diario) || 0;
    if (limit > 0) {
      const sentToday = db.prepare(`SELECT COUNT(*) n FROM messages m JOIN campaigns k ON k.id=m.campaign_id WHERE k.connection_id=? AND m.sent_at >= ?`).get(c.connection_id, startOfTodaySP()).n;
      if (sentToday >= limit) {
        db.prepare('UPDATE campaigns SET next_send_at=?, pause_reason=? WHERE id=?').run(Date.now() + 5 * 60_000, `Limite diário de ${limit} mensagens deste número atingido — continua amanhã automaticamente`, c.id);
        return;
      }
    }
    const msg = db.prepare("SELECT * FROM messages WHERE campaign_id=? AND status='pendente' ORDER BY id LIMIT 1").get(c.id);
    if (!msg) {
      db.prepare("UPDATE campaigns SET status='concluida', finished_at=?, pause_reason=NULL WHERE id=?").run(now(), c.id);
      return;
    }
    // opt-out pode ter chegado durante a campanha
    if (db.prepare('SELECT 1 FROM optouts WHERE workspace_id=? AND phone=?').get(c.workspace_id, msg.phone)) {
      db.prepare("UPDATE messages SET status='ignorado', error='Pediu para não receber (SAIR)', updated_at=? WHERE id=?").run(now(), msg.id);
      return;
    }
    db.prepare("UPDATE messages SET status='enviando', attempts=attempts+1, updated_at=? WHERE id=?").run(now(), msg.id);
    const vars = parseJSON(msg.vars_json, {});
    const payload = { phone: msg.phone, typing: settings.digitacao };
    let rendered = '', aiNote = null;
    if (c.mode === 'template') {
      const p = parseJSON(c.template_params_json, {});
      payload.template = {
        name: c.template_name, lang: c.template_lang,
        body: (p.body || []).map(v => renderVars(v, vars)),
        header: p.header ? (p.header.type === 'text' ? { type: 'text', value: renderVars(p.header.value, vars) }
          : c.media_file ? { type: p.header.type, mediaPath: path.join(DATA_DIR, 'uploads', c.media_file), mime: c.media_type, name: c.media_name } : null) : null,
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
        payload.media = {
          path: path.join(DATA_DIR, 'uploads', c.media_file), mime, name: c.media_name || c.media_file,
          kind: mime.startsWith('image/') ? 'image' : mime.startsWith('video/') ? 'video' : mime.startsWith('audio/') ? 'audio' : 'document',
        };
      }
    }
    try {
      const { id } = await driver.send(payload);
      db.prepare("UPDATE messages SET status='enviado', wa_message_id=?, rendered=?, sent_at=?, updated_at=?, error=? WHERE id=?")
        .run(id || null, rendered, now(), now(), aiNote, msg.id);
    } catch (e) {
      if (e.code === 'DISCONNECTED') {
        db.prepare("UPDATE messages SET status='pendente', attempts=attempts-1 WHERE id=?").run(msg.id);
        db.prepare("UPDATE campaigns SET status='pausada', pause_reason=? WHERE id=?").run('A conexão do WhatsApp caiu. Reconecte e clique em Retomar.', c.id);
        return;
      }
      const retry = e.code === 'TEMP' && msg.attempts + 1 < 3;
      db.prepare('UPDATE messages SET status=?, error=?, rendered=?, updated_at=? WHERE id=?')
        .run(retry ? 'pendente' : (e.code === 'NO_WHATSAPP' ? 'sem_whatsapp' : 'falhou'), e.message, rendered, now(), msg.id);
    }
    // agenda o próximo envio
    const sp = speedConfig(conn.type, c.speed, c);
    let delay = rand(sp.min, sp.max) * 1000, sincePause = c.sent_since_pause + 1, reason = null;
    if (sp.every && sincePause >= rand(sp.every[0], sp.every[1])) {
      const pause = rand(sp.pause[0], sp.pause[1]) * 1000;
      delay += pause; sincePause = 0;
      reason = `Pausa programada (${Math.round(pause / 60000) || 1} min) para proteger seu número`;
    }
    db.prepare('UPDATE campaigns SET next_send_at=?, sent_since_pause=?, pause_reason=? WHERE id=?').run(Date.now() + delay, sincePause, reason, c.id);
  } catch (e) {
    console.error('Erro na campanha', c.id, e);
  } finally {
    busy.delete(c.id);
  }
}

export function startQueue() {
  // mensagens presas em "enviando" após reinício voltam para a fila
  db.prepare("UPDATE messages SET status='pendente' WHERE status='enviando'").run();
  setInterval(() => {
    const due = db.prepare("SELECT * FROM campaigns WHERE status='agendada' AND scheduled_at <= ?").all(now());
    for (const c of due) {
      prepareCampaign(c.id);
      db.prepare("UPDATE campaigns SET status='enviando', started_at=COALESCE(started_at, ?), next_send_at=0 WHERE id=?").run(now(), c.id);
    }
    const active = db.prepare("SELECT * FROM campaigns WHERE status='enviando' AND next_send_at <= ?").all(Date.now());
    for (const c of active) processCampaign(c);
  }, 1000);
}
