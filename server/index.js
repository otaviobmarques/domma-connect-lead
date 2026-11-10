import express from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, parseJSON, DATA_DIR } from './db.js';
import { parseSpreadsheet, detectColumns, toXlsxBuffer } from './spreadsheet.js';
import { normalizePhone, formatPhone } from './phone.js';
import { renderMessage, usedVariables } from './render.js';
import { startConnection, logoutConnection, getDriver, bootConnections, handleMetaWebhook, rowToConn, stopConnection } from './connections.js';
import { startQueue, prepareCampaign, estimateSeconds, contactVars, SPEEDS } from './queue.js';
import { personalize, testAI, encrypt, hasAI, PROVIDERS } from './ai.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from './settings.js';
import { hoursLabel } from './queue.js';
import { MODELOS } from './modelos.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const secretFile = path.join(DATA_DIR, '.jwt-secret');
const JWT_SECRET = process.env.JWT_SECRET || (fs.existsSync(secretFile) ? fs.readFileSync(secretFile, 'utf8')
  : (() => { const s = crypto.randomBytes(48).toString('hex'); fs.writeFileSync(secretFile, s); return s; })());

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const mediaUpload = multer({
  storage: multer.diskStorage({
    destination: path.join(DATA_DIR, 'uploads'),
    filename: (_, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + path.extname(f.originalname).toLowerCase()),
  }),
  limits: { fileSize: 16 * 1024 * 1024 },
});

// ---------- helpers
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

function auth(req, res, next) {
  const token = req.cookies.cl_token || (req.headers.authorization || '').replace(/^Bearer /, '');
  try {
    const p = jwt.verify(token, JWT_SECRET);
    req.user = db.prepare('SELECT id, name, email, workspace_id, role FROM users WHERE id=?').get(p.uid);
    if (!req.user) throw new Error();
    req.ws = req.user.workspace_id;
    next();
  } catch { res.status(401).json({ error: 'Faça login novamente' }); }
}
function setSession(res, uid) {
  const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
  res.cookie('cl_token', token, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 });
}
const own = (table, id, ws) => db.prepare(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`).get(id, ws) || fail(404, 'Não encontrado');
const publicConn = c => {
  const cfg = parseJSON(c.config_json, {});
  return { id: c.id, name: c.name, type: c.type, status: c.status, phone: c.phone, phone_fmt: formatPhone(c.phone), created_at: c.created_at,
    last_error: cfg.last_error || null, meta: cfg.meta || null,
    config: c.type === 'oficial' ? { phone_number_id: cfg.phone_number_id || '', waba_id: cfg.waba_id || '', has_token: !!cfg.access_token } : {} };
};
function campaignStats(id) {
  const rows = db.prepare('SELECT status, COUNT(*) n FROM messages WHERE campaign_id=? GROUP BY status').all(id);
  const s = { total: 0, pendente: 0, enviando: 0, enviado: 0, entregue: 0, lido: 0, falhou: 0, sem_whatsapp: 0, ignorado: 0 };
  for (const r of rows) { s[r.status] = r.n; s.total += r.n; }
  s.respondeu = db.prepare('SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND replied=1').get(id).n;
  s.sucesso = s.enviado + s.entregue + s.lido;
  s.processado = s.total - s.pendente - s.enviando;
  return s;
}

// ---------- auth
app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password, company } = req.body || {};
  if (!name || !email || !password) fail(400, 'Preencha nome, e-mail e senha');
  if (password.length < 6) fail(400, 'A senha precisa ter pelo menos 6 caracteres');
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email.toLowerCase())) fail(400, 'Este e-mail já tem cadastro');
  const ws = db.prepare('INSERT INTO workspaces (name, webhook_token) VALUES (?,?)').run(company || name, crypto.randomBytes(12).toString('hex'));
  const u = db.prepare('INSERT INTO users (workspace_id, name, email, password_hash) VALUES (?,?,?,?)')
    .run(ws.lastInsertRowid, name, email.toLowerCase(), await bcrypt.hash(password, 10));
  setSession(res, u.lastInsertRowid);
  res.json({ ok: true });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(String(email || '').toLowerCase());
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) fail(401, 'E-mail ou senha incorretos');
  setSession(res, u.id);
  res.json({ ok: true });
}));
app.post('/api/auth/logout', (req, res) => { res.clearCookie('cl_token'); res.json({ ok: true }); });
app.get('/api/me', auth, (req, res) => {
  const ws = db.prepare('SELECT id, name, plan FROM workspaces WHERE id=?').get(req.ws);
  res.json({ user: req.user, workspace: { ...ws, logo: getSettings(req.ws).perfil.logo } });
});

// ---------- configurações (resumo para o painel) e administrador
app.get('/api/settings', auth, (req, res) => {
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.ws);
  const st = getSettings(ws);
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ name: st.perfil.nome, logo: st.perfil.logo, optout_footer: st.disparo.rodape_optout, ai_has_key: hasAI(st),
    business_profile: !!(st.perfil.descricao || st.playbook.produtos), gallery: st.galeria, disparo: st.disparo, hours_label: hoursLabel(st.disparo),
    webhook_url: `${base}/webhook/meta`, webhook_token: ws.webhook_token });
});
function adminView(ws) {
  const st = getSettings(ws);
  const provs = Object.fromEntries(Object.keys(PROVIDERS).map(k => [k, { label: PROVIDERS[k].label, default_model: PROVIDERS[k].model,
    model: st.ia.provedores?.[k]?.model || '', has_key: !!st.ia.provedores?.[k]?.key || !!process.env[PROVIDERS[k].env] }]));
  return { ...st, ia: { ...st.ia, provedores: provs } };
}
const adminOnly = (req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Apenas o administrador pode alterar isto' });
app.get('/api/admin', auth, adminOnly, (req, res) => res.json(adminView(db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.ws))));
app.patch('/api/admin/:section', auth, adminOnly, (req, res) => {
  const sec = req.params.section;
  if (!['perfil', 'playbook', 'ia', 'disparo', 'digitacao'].includes(sec)) fail(400, 'Seção inválida');
  const ws = db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.ws);
  const st = getSettings(ws);
  const body = req.body || {};
  const pick = (obj, def) => Object.fromEntries(Object.keys(def).filter(k => k in obj).map(k => [k, obj[k]]));
  if (sec === 'ia') {
    const ia = { ...st.ia, ...pick(body, { principal: 1, reserva: 1, criatividade: 1, tamanho: 1 }) };
    if (ia.principal && !PROVIDERS[ia.principal]) fail(400, 'IA principal inválida');
    if (ia.reserva && !PROVIDERS[ia.reserva]) ia.reserva = '';
    for (const k of Object.keys(PROVIDERS)) {
      const inc = body.provedores?.[k]; if (!inc) continue;
      const cur = ia.provedores[k] || {};
      ia.provedores[k] = { key: inc.remove_key ? null : (String(inc.key || '').trim() ? encrypt(String(inc.key).trim()) : cur.key || null), model: String(inc.model ?? cur.model ?? '').trim() };
    }
    st.ia = ia;
  } else if (sec === 'disparo') {
    const d = { ...st.disparo, ...pick(body, DEFAULT_SETTINGS.disparo) };
    for (const k of ['custom_min', 'custom_max', 'custom_every', 'custom_pause', 'limite_diario', 'horario_inicio', 'horario_fim']) d[k] = Math.max(0, Number(d[k]) || 0);
    if (d.custom_max < d.custom_min) fail(400, 'O intervalo máximo precisa ser maior ou igual ao mínimo');
    if (d.horario_fim <= d.horario_inicio) fail(400, 'O horário final precisa ser depois do inicial');
    d.dias = (Array.isArray(d.dias) ? d.dias : []).map(Number).filter(n => n >= 0 && n <= 6);
    if (!d.dias.length) fail(400, 'Escolha pelo menos um dia da semana');
    st.disparo = d;
  } else if (sec === 'digitacao') {
    const t = { ...st.digitacao, ...pick(body, DEFAULT_SETTINGS.digitacao) };
    t.velocidade = Math.max(1, Number(t.velocidade) || 18); t.min = Math.max(0, Number(t.min) || 0); t.max = Math.max(t.min, Number(t.max) || t.min);
    t.ligado = !!t.ligado;
    st.digitacao = t;
  } else {
    st[sec] = { ...st[sec], ...pick(body, DEFAULT_SETTINGS[sec]) };
    for (const k of Object.keys(st[sec])) if (typeof st[sec][k] === 'string') st[sec][k] = st[sec][k].slice(0, 6000);
  }
  saveSettings(req.ws, st);
  res.json(adminView(db.prepare('SELECT * FROM workspaces WHERE id=?').get(req.ws)));
});
app.post('/api/admin/test-ai', auth, adminOnly, wrap(async (req, res) => {
  res.json(await testAI(getSettings(req.ws), req.body?.provider));
}));
app.post('/api/admin/logo', auth, adminOnly, mediaUpload.single('file'), (req, res) => {
  if (!req.file || !req.file.mimetype.startsWith('image/')) fail(400, 'Envie uma imagem');
  const st = getSettings(req.ws); st.perfil.logo = req.file.filename; saveSettings(req.ws, st);
  res.json({ logo: req.file.filename });
});
app.post('/api/admin/galeria', auth, adminOnly, mediaUpload.single('file'), (req, res) => {
  if (!req.file) fail(400, 'Envie um arquivo');
  const st = getSettings(req.ws);
  st.galeria = [{ file: req.file.filename, mime: req.file.mimetype, name: req.file.originalname, size: req.file.size, titulo: String(req.body?.titulo || req.file.originalname).slice(0, 80) }, ...st.galeria].slice(0, 200);
  saveSettings(req.ws, st);
  res.json(st.galeria);
});
app.delete('/api/admin/galeria/:file', auth, adminOnly, (req, res) => {
  const st = getSettings(req.ws);
  st.galeria = st.galeria.filter(g => g.file !== req.params.file);
  saveSettings(req.ws, st);
  res.json(st.galeria);
});
app.post('/api/ai/preview', auth, wrap(async (req, res) => {
  const { message, instructions, list_id } = req.body || {};
  const st = getSettings(req.ws);
  let contacts = [];
  if (list_id) { own('lists', list_id, req.ws); contacts = db.prepare("SELECT * FROM contacts WHERE list_id=? AND status='valido' ORDER BY row_number LIMIT 3").all(list_id); }
  const sample = contacts.length ? contacts.map(contactVars) : [{ nome: 'Maria Silva', primeiro_nome: 'Maria', telefone: '5531988887777' }];
  const out = await Promise.all(sample.map(async v => {
    try { return { nome: v.nome, telefone: formatPhone(v.telefone), texto: await personalize(st, { base: renderMessage(message, v), instructions, contact: v }) }; }
    catch (e) { return { nome: v.nome, telefone: formatPhone(v.telefone), erro: e.message }; }
  }));
  if (out.every(o => o.erro)) fail(400, out[0].erro);
  res.json({ previews: out });
}));

// ---------- conexões
app.get('/api/connections', auth, (req, res) => {
  res.json(db.prepare('SELECT * FROM connections WHERE workspace_id=? ORDER BY id').all(req.ws).map(publicConn));
});
app.post('/api/connections', auth, wrap(async (req, res) => {
  const { name, type, config = {} } = req.body || {};
  if (!['qr', 'oficial', 'simulado'].includes(type)) fail(400, 'Tipo de conexão inválido');
  const cfg = type === 'oficial' ? { phone_number_id: String(config.phone_number_id || '').trim(), waba_id: String(config.waba_id || '').trim(), access_token: String(config.access_token || '').trim() } : {};
  const r = db.prepare('INSERT INTO connections (workspace_id, name, type, config_json) VALUES (?,?,?,?)')
    .run(req.ws, name || ({ qr: 'WhatsApp (QR Code)', oficial: 'WhatsApp API Oficial', simulado: 'Conexão de teste' })[type], type, JSON.stringify(cfg));
  const id = Number(r.lastInsertRowid);
  if (type !== 'qr') await startConnection(id);
  else startConnection(id).catch(e => console.error(e));
  res.json(publicConn(db.prepare('SELECT * FROM connections WHERE id=?').get(id)));
}));
app.patch('/api/connections/:id', auth, wrap(async (req, res) => {
  const c = own('connections', req.params.id, req.ws);
  const cfg = parseJSON(c.config_json, {});
  const { name, config } = req.body || {};
  if (config && c.type === 'oficial') {
    for (const k of ['phone_number_id', 'waba_id', 'access_token']) if (config[k]) cfg[k] = String(config[k]).trim();
  }
  db.prepare('UPDATE connections SET name=COALESCE(?,name), config_json=? WHERE id=?').run(name || null, JSON.stringify(cfg), c.id);
  if (config && c.type === 'oficial') await startConnection(c.id);
  res.json(publicConn(db.prepare('SELECT * FROM connections WHERE id=?').get(c.id)));
}));
app.post('/api/connections/:id/connect', auth, wrap(async (req, res) => {
  const c = own('connections', req.params.id, req.ws);
  if (c.type === 'qr') startConnection(c.id).catch(e => console.error(e)); else await startConnection(c.id);
  res.json({ ok: true });
}));
app.get('/api/connections/:id/qr', auth, (req, res) => {
  const c = own('connections', req.params.id, req.ws);
  const d = getDriver(c.id);
  res.json({ status: c.status, qr: d?.qr || null, phone_fmt: formatPhone(c.phone), last_error: parseJSON(c.config_json, {}).last_error || null });
});
app.post('/api/connections/:id/disconnect', auth, wrap(async (req, res) => {
  const c = own('connections', req.params.id, req.ws);
  await logoutConnection(c.id);
  res.json({ ok: true });
}));
app.delete('/api/connections/:id', auth, wrap(async (req, res) => {
  const c = own('connections', req.params.id, req.ws);
  if (db.prepare("SELECT 1 FROM campaigns WHERE connection_id=? AND status IN ('enviando','agendada','pausada')").get(c.id)) fail(400, 'Há campanhas ativas usando esta conexão. Cancele-as antes.');
  await logoutConnection(c.id).catch(() => {});
  await stopConnection(c.id);
  db.prepare("UPDATE connections SET status='removida', workspace_id=-workspace_id WHERE id=?").run(c.id);
  res.json({ ok: true });
}));
app.get('/api/connections/:id/templates', auth, wrap(async (req, res) => {
  const c = own('connections', req.params.id, req.ws);
  if (c.type !== 'oficial') fail(400, 'Modelos só existem na API Oficial');
  const d = getDriver(c.id) || await startConnection(c.id);
  const list = await d.templates();
  res.json(list.map(t => {
    const body = t.components?.find(x => x.type === 'BODY')?.text || '';
    const header = t.components?.find(x => x.type === 'HEADER');
    return { name: t.name, language: t.language, category: t.category, body, footer: t.components?.find(x => x.type === 'FOOTER')?.text || '',
      header: header ? { format: header.format, text: header.text || '' } : null,
      body_params: (body.match(/\{\{\d+\}\}/g) || []).length,
      header_params: header?.format === 'TEXT' ? (header.text?.match(/\{\{\d+\}\}/g) || []).length : 0 };
  }));
}));

// ---------- listas
function importRows(listId, ws, rows, phoneColumn, nameColumn, defaultDDD) {
  db.prepare('DELETE FROM contacts WHERE list_id=?').run(listId);
  const ins = db.prepare('INSERT INTO contacts (list_id, workspace_id, row_number, phone, name, data_json, status, error) VALUES (?,?,?,?,?,?,?,?)');
  const seen = new Set(); let valid = 0, invalid = 0, dup = 0;
  db.transaction(() => {
    rows.forEach((r, i) => {
      const n = phoneColumn ? normalizePhone(r[phoneColumn], { defaultDDD }) : { ok: false, error: 'Coluna de telefone não escolhida' };
      let status = 'valido', error = null, phone = n.ok ? n.phone : String(r[phoneColumn] ?? '');
      if (!n.ok) { status = 'invalido'; error = n.error; invalid++; }
      else if (seen.has(n.phone)) { status = 'duplicado'; error = 'Telefone repetido na planilha'; dup++; }
      else { seen.add(n.phone); valid++; }
      ins.run(listId, ws, i + 2, phone, nameColumn ? (r[nameColumn] || '') : '', JSON.stringify(r), status, error);
    });
  })();
  db.prepare('UPDATE lists SET phone_column=?, name_column=?, total=?, valid=?, invalid=?, duplicates=? WHERE id=?')
    .run(phoneColumn, nameColumn, rows.length, valid, invalid, dup, listId);
}
function listSummary(id) {
  const l = db.prepare('SELECT * FROM lists WHERE id=?').get(id);
  const optouts = db.prepare(`SELECT COUNT(*) n FROM contacts c JOIN optouts o ON o.phone=c.phone AND o.workspace_id=c.workspace_id WHERE c.list_id=? AND c.status='valido'`).get(id).n;
  const preview = db.prepare('SELECT row_number, phone, name, data_json, status, error FROM contacts WHERE list_id=? ORDER BY row_number LIMIT 8').all(id)
    .map(c => ({ ...c, data: parseJSON(c.data_json, {}), data_json: undefined, phone_fmt: c.status === 'invalido' ? c.phone : formatPhone(c.phone) }));
  return { ...l, columns: parseJSON(l.columns_json, []), columns_json: undefined, optouts, preview };
}
app.post('/api/lists/import', auth, upload.single('file'), wrap(async (req, res) => {
  if (!req.file) fail(400, 'Envie uma planilha (.xlsx, .xls ou .csv)');
  let parsed;
  try { parsed = parseSpreadsheet(req.file.buffer, req.file.originalname); } catch (e) { fail(400, 'Não consegui ler a planilha: ' + e.message); }
  if (!parsed.rows.length) fail(400, 'A planilha não tem linhas com dados');
  if (parsed.rows.length > 100000) fail(400, 'Limite de 100.000 linhas por planilha');
  const name = (req.body.name || req.file.originalname.replace(/\.[^.]+$/, '')).slice(0, 120);
  const r = db.prepare('INSERT INTO lists (workspace_id, name, columns_json) VALUES (?,?,?)').run(req.ws, name, JSON.stringify(parsed.columns));
  importRows(r.lastInsertRowid, req.ws, parsed.rows, parsed.phoneColumn, parsed.nameColumn, req.body.defaultDDD || null);
  res.json(listSummary(r.lastInsertRowid));
}));
app.post('/api/lists/:id/remap', auth, (req, res) => {
  const l = own('lists', req.params.id, req.ws);
  const rows = db.prepare('SELECT data_json FROM contacts WHERE list_id=? ORDER BY row_number').all(l.id).map(c => parseJSON(c.data_json, {}));
  const { phoneColumn, nameColumn, defaultDDD } = req.body || {};
  importRows(l.id, req.ws, rows, phoneColumn || null, nameColumn || null, defaultDDD || null);
  res.json(listSummary(l.id));
});
app.get('/api/lists', auth, (req, res) => {
  res.json(db.prepare('SELECT id, name, total, valid, invalid, duplicates, created_at, columns_json FROM lists WHERE workspace_id=? ORDER BY id DESC').all(req.ws)
    .map(l => ({ ...l, columns: parseJSON(l.columns_json, []), columns_json: undefined })));
});
app.get('/api/lists/:id', auth, (req, res) => {
  const l = own('lists', req.params.id, req.ws);
  const page = Math.max(1, Number(req.query.page) || 1), per = 50;
  const st = req.query.status;
  const where = st ? 'AND status=?' : '';
  const args = st ? [l.id, st] : [l.id];
  const contacts = db.prepare(`SELECT row_number, phone, name, data_json, status, error FROM contacts WHERE list_id=? ${where} ORDER BY row_number LIMIT ${per} OFFSET ${(page - 1) * per}`).all(...args)
    .map(c => ({ ...c, data: parseJSON(c.data_json, {}), data_json: undefined, phone_fmt: c.status === 'invalido' ? c.phone : formatPhone(c.phone) }));
  const count = db.prepare(`SELECT COUNT(*) n FROM contacts WHERE list_id=? ${where}`).get(...args).n;
  res.json({ ...listSummary(l.id), contacts, page, pages: Math.max(1, Math.ceil(count / per)) });
});
app.get('/api/lists/:id/export', auth, (req, res) => {
  const l = own('lists', req.params.id, req.ws);
  const st = req.query.status;
  const rows = db.prepare(`SELECT * FROM contacts WHERE list_id=? ${st ? 'AND status=?' : ''} ORDER BY row_number`).all(...(st ? [l.id, st] : [l.id]))
    .map(c => ({ Linha: c.row_number, Situação: c.status, Motivo: c.error || '', 'Telefone tratado': c.status === 'valido' ? c.phone : '', ...parseJSON(c.data_json, {}) }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="lista-${l.id}${st ? '-' + st : ''}.xlsx"`);
  res.send(toXlsxBuffer(rows, 'Contatos'));
});
app.delete('/api/lists/:id', auth, (req, res) => {
  const l = own('lists', req.params.id, req.ws);
  if (db.prepare('SELECT 1 FROM campaigns WHERE list_id=?').get(l.id)) fail(400, 'Esta lista já foi usada em campanhas e não pode ser apagada');
  db.prepare('DELETE FROM lists WHERE id=?').run(l.id);
  res.json({ ok: true });
});

// ---------- mídia
app.post('/api/media', auth, mediaUpload.single('file'), (req, res) => {
  if (!req.file) fail(400, 'Envie um arquivo');
  res.json({ file: req.file.filename, mime: req.file.mimetype, name: req.file.originalname, size: req.file.size });
});
app.get('/media/:file', auth, (req, res) => {
  const f = path.join(DATA_DIR, 'uploads', path.basename(req.params.file));
  if (!fs.existsSync(f)) return res.status(404).end();
  res.sendFile(f);
});

// ---------- modelos / prévia / estimativa
app.get('/api/modelos', auth, (req, res) => res.json(MODELOS));
app.post('/api/preview', auth, (req, res) => {
  const { message, list_id, add_optout_footer } = req.body || {};
  const ws = { optout_footer: getSettings(req.ws).disparo.rodape_optout };
  let contacts = [];
  if (list_id) { own('lists', list_id, req.ws); contacts = db.prepare("SELECT * FROM contacts WHERE list_id=? AND status='valido' ORDER BY row_number LIMIT 3").all(list_id); }
  const sample = contacts.length ? contacts.map(contactVars) : [{ nome: 'Maria Silva', primeiro_nome: 'Maria', telefone: '5531988887777' }];
  const out = sample.map(v => {
    let t = renderMessage(message, v);
    if (add_optout_footer && ws?.optout_footer) t += `\n\n_${ws.optout_footer}_`;
    return { nome: v.nome, telefone: formatPhone(v.telefone), texto: t };
  });
  const list = list_id ? db.prepare('SELECT columns_json FROM lists WHERE id=?').get(list_id) : null;
  const known = new Set(['nome', 'primeiro_nome', 'telefone', 'saudacao', ...parseJSON(list?.columns_json, []).map(c => c.key)]);
  res.json({ previews: out, unknown_vars: [...new Set(usedVariables(message))].filter(v => !known.has(v)) });
});
app.post('/api/estimate', auth, (req, res) => {
  const { connection_id, speed, count, custom } = req.body || {};
  const c = connection_id ? own('connections', connection_id, req.ws) : { type: 'qr' };
  res.json({ seconds: estimateSeconds(c.type, speed, Number(count) || 0, custom || {}), speeds: SPEEDS[c.type] });
});

// ---------- campanhas
app.get('/api/campaigns', auth, (req, res) => {
  const rows = db.prepare(`SELECT c.*, l.name list_name, n.name connection_name, n.type connection_type FROM campaigns c
    JOIN lists l ON l.id=c.list_id JOIN connections n ON n.id=c.connection_id WHERE c.workspace_id=? ORDER BY c.id DESC`).all(req.ws);
  res.json(rows.map(c => ({ ...c, stats: campaignStats(c.id) })));
});
app.post('/api/campaigns', auth, (req, res) => {
  const b = req.body || {};
  const list = own('lists', b.list_id, req.ws);
  const conn = own('connections', b.connection_id, req.ws);
  if (!b.name) fail(400, 'Dê um nome para a campanha');
  if (list.valid === 0) fail(400, 'A lista não tem nenhum telefone válido');
  const mode = conn.type === 'oficial' && b.mode === 'template' ? 'template' : 'texto';
  const aiOn = mode === 'texto' && !!b.ai_enabled;
  if (mode === 'texto' && !String(b.message || '').trim() && !b.media_file && !(aiOn && String(b.ai_instructions || '').trim())) fail(400, 'Escreva a mensagem');
  if (aiOn && !hasAI(getSettings(req.ws))) fail(400, 'Configure uma IA no Administrador antes de usar a personalização');
  const speed = ['segura', 'normal', 'rapida', 'personalizado'].includes(b.speed) ? b.speed : 'segura';
  const cmin = Math.max(1, Math.round(Number(b.custom_min) || 0)), cmax = Math.round(Number(b.custom_max) || 0);
  if (speed === 'personalizado' && (!b.custom_min || cmax < cmin)) fail(400, 'No intervalo personalizado, o máximo precisa ser maior ou igual ao mínimo');
  if (mode === 'template' && !b.template_name) fail(400, 'Escolha o modelo aprovado pela Meta');
  const scheduled = b.scheduled_at ? new Date(b.scheduled_at) : null;
  if (scheduled && isNaN(scheduled)) fail(400, 'Data de agendamento inválida');
  const status = b.start === false ? 'rascunho' : scheduled && scheduled > new Date() ? 'agendada' : 'enviando';
  const r = db.prepare(`INSERT INTO campaigns (workspace_id, name, list_id, connection_id, mode, message, media_file, media_type, media_name,
    template_name, template_lang, template_params_json, add_optout_footer, speed, business_hours, scheduled_at, status, started_at,
    custom_min, custom_max, custom_every, custom_pause, ai_enabled, ai_instructions)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(req.ws, b.name, list.id, conn.id, mode, b.message || '', b.media_file || null, b.media_type || null, b.media_name || null,
    b.template_name || null, b.template_lang || null, JSON.stringify(b.template_params || {}), b.add_optout_footer === false ? 0 : 1,
    speed, b.business_hours === false ? 0 : 1,
    scheduled ? scheduled.toISOString() : null, status, status === 'enviando' ? now() : null,
    speed === 'personalizado' ? cmin : null, speed === 'personalizado' ? cmax : null,
    speed === 'personalizado' ? (Math.round(Number(b.custom_every)) || null) : null, speed === 'personalizado' ? (Math.round(Number(b.custom_pause)) || null) : null,
    aiOn ? 1 : 0, aiOn ? String(b.ai_instructions || '') : null);
  if (status === 'enviando') prepareCampaign(r.lastInsertRowid);
  res.json({ id: r.lastInsertRowid, status });
});
app.get('/api/campaigns/:id', auth, (req, res) => {
  const c = own('campaigns', req.params.id, req.ws);
  const list = db.prepare('SELECT id, name FROM lists WHERE id=?').get(c.list_id);
  const conn = db.prepare('SELECT * FROM connections WHERE id=?').get(c.connection_id);
  const stats = campaignStats(c.id);
  const remaining = stats.total ? stats.pendente : db.prepare("SELECT valid n FROM lists WHERE id=?").get(c.list_id).n;
  res.json({ ...c, template_params: parseJSON(c.template_params_json, {}), list, connection: publicConn(conn), stats,
    eta_seconds: ['enviando', 'pausada', 'agendada'].includes(c.status) ? estimateSeconds(conn.type, c.speed, remaining, c) : 0 });
});
app.get('/api/campaigns/:id/messages', auth, (req, res) => {
  const c = own('campaigns', req.params.id, req.ws);
  const page = Math.max(1, Number(req.query.page) || 1), per = 50;
  const st = req.query.status;
  let where = '', args = [c.id];
  if (st === 'sucesso') where = "AND status IN ('enviado','entregue','lido')";
  else if (st === 'respondeu') where = 'AND replied=1';
  else if (st === 'erro') where = "AND status IN ('falhou','sem_whatsapp')";
  else if (st) { where = 'AND status=?'; args.push(st); }
  const rows = db.prepare(`SELECT id, phone, name, status, error, sent_at, replied, reply_text, rendered FROM messages WHERE campaign_id=? ${where} ORDER BY id LIMIT ${per} OFFSET ${(page - 1) * per}`).all(...args)
    .map(m => ({ ...m, phone_fmt: formatPhone(m.phone) }));
  const count = db.prepare(`SELECT COUNT(*) n FROM messages WHERE campaign_id=? ${where}`).get(...args).n;
  res.json({ rows, page, pages: Math.max(1, Math.ceil(count / per)), count });
});
app.post('/api/campaigns/:id/:action', auth, (req, res) => {
  const a = req.params.action;
  if (!['pause', 'resume', 'cancel', 'start', 'retry'].includes(a)) fail(404, 'Ação desconhecida');
  const c = own('campaigns', req.params.id, req.ws);
  if (a === 'pause' && ['enviando', 'agendada'].includes(c.status)) db.prepare("UPDATE campaigns SET status='pausada', pause_reason='Pausada por você' WHERE id=?").run(c.id);
  else if ((a === 'resume' || a === 'start') && ['pausada', 'rascunho'].includes(c.status)) {
    prepareCampaign(c.id);
    db.prepare("UPDATE campaigns SET status='enviando', next_send_at=0, pause_reason=NULL, started_at=COALESCE(started_at, ?) WHERE id=?").run(now(), c.id);
  } else if (a === 'cancel' && !['concluida', 'cancelada'].includes(c.status)) {
    db.prepare("UPDATE messages SET status='ignorado', error='Campanha cancelada' WHERE campaign_id=? AND status='pendente'").run(c.id);
    db.prepare("UPDATE campaigns SET status='cancelada', finished_at=?, pause_reason=NULL WHERE id=?").run(now(), c.id);
  } else if (a === 'retry') {
    const n = db.prepare("UPDATE messages SET status='pendente', error=NULL, attempts=0 WHERE campaign_id=? AND status='falhou'").run(c.id).changes;
    if (!n) fail(400, 'Não há envios com falha para tentar de novo');
    db.prepare("UPDATE campaigns SET status='enviando', next_send_at=0, finished_at=NULL, pause_reason=NULL WHERE id=?").run(c.id);
  } else fail(400, 'Ação não permitida no status atual');
  res.json({ ok: true });
});
app.get('/api/campaigns/:id/export', auth, (req, res) => {
  const c = own('campaigns', req.params.id, req.ws);
  const label = { pendente: 'Na fila', enviando: 'Enviando', enviado: 'Enviado', entregue: 'Entregue', lido: 'Lido', falhou: 'Falhou', sem_whatsapp: 'Sem WhatsApp', ignorado: 'Não enviado' };
  const rows = db.prepare('SELECT * FROM messages WHERE campaign_id=? ORDER BY id').all(c.id).map(m => ({
    Nome: m.name || '', Telefone: formatPhone(m.phone), Situação: label[m.status] || m.status, Motivo: m.error || '',
    'Enviado em': m.sent_at ? new Date(m.sent_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
    Respondeu: m.replied ? 'Sim' : 'Não', Resposta: m.reply_text || '', Mensagem: m.rendered || '',
  }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="campanha-${c.id}.xlsx"`);
  res.send(toXlsxBuffer(rows));
});
app.delete('/api/campaigns/:id', auth, (req, res) => {
  const c = own('campaigns', req.params.id, req.ws);
  if (['enviando', 'agendada'].includes(c.status)) fail(400, 'Pause ou cancele a campanha antes de apagar');
  db.prepare('DELETE FROM campaigns WHERE id=?').run(c.id);
  res.json({ ok: true });
});

// ---------- painel
app.get('/api/dashboard', auth, (req, res) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const m = db.prepare(`SELECT
      SUM(CASE WHEN m.status IN ('enviado','entregue','lido') THEN 1 ELSE 0 END) enviados,
      SUM(CASE WHEN m.status IN ('entregue','lido') THEN 1 ELSE 0 END) entregues,
      SUM(CASE WHEN m.status='lido' THEN 1 ELSE 0 END) lidos,
      SUM(m.replied) respostas,
      SUM(CASE WHEN m.status IN ('falhou','sem_whatsapp') THEN 1 ELSE 0 END) erros
    FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE c.workspace_id=? AND COALESCE(m.sent_at, m.updated_at) >= ?`).get(req.ws, since);
  const daily = db.prepare(`SELECT substr(m.sent_at,1,10) dia, COUNT(*) n FROM messages m JOIN campaigns c ON c.id=m.campaign_id
    WHERE c.workspace_id=? AND m.sent_at >= ? GROUP BY dia ORDER BY dia`).all(req.ws, new Date(Date.now() - 14 * 864e5).toISOString());
  const active = db.prepare("SELECT id, name, status, pause_reason FROM campaigns WHERE workspace_id=? AND status IN ('enviando','agendada','pausada') ORDER BY id DESC").all(req.ws)
    .map(c => ({ ...c, stats: campaignStats(c.id) }));
  const conns = db.prepare('SELECT * FROM connections WHERE workspace_id=?').all(req.ws).map(publicConn);
  const optouts = db.prepare('SELECT COUNT(*) n FROM optouts WHERE workspace_id=?').get(req.ws).n;
  res.json({ metrics: { enviados: m.enviados || 0, entregues: m.entregues || 0, lidos: m.lidos || 0, respostas: m.respostas || 0, erros: m.erros || 0, optouts }, daily, active, connections: conns,
    lists: db.prepare('SELECT COUNT(*) n FROM lists WHERE workspace_id=?').get(req.ws).n });
});

// ---------- descadastrados (opt-out)
app.get('/api/optouts', auth, (req, res) => {
  res.json(db.prepare('SELECT phone, reason, created_at FROM optouts WHERE workspace_id=? ORDER BY created_at DESC').all(req.ws).map(o => ({ ...o, phone_fmt: formatPhone(o.phone) })));
});
app.post('/api/optouts', auth, (req, res) => {
  const n = normalizePhone(req.body?.phone);
  if (!n.ok) fail(400, n.error);
  db.prepare('INSERT OR IGNORE INTO optouts (workspace_id, phone, reason) VALUES (?,?,?)').run(req.ws, n.phone, 'Adicionado manualmente');
  res.json({ ok: true });
});
app.delete('/api/optouts/:phone', auth, (req, res) => {
  db.prepare('DELETE FROM optouts WHERE workspace_id=? AND phone=?').run(req.ws, req.params.phone);
  res.json({ ok: true });
});

// ---------- webhook da Meta (API Oficial)
app.get('/webhook/meta', (req, res) => {
  const token = req.query['hub.verify_token'];
  const valid = token && (token === process.env.META_VERIFY_TOKEN || db.prepare('SELECT 1 FROM workspaces WHERE webhook_token=?').get(token));
  if (req.query['hub.mode'] === 'subscribe' && valid) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
});
app.post('/webhook/meta', (req, res) => {
  if (process.env.META_APP_SECRET) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody || '').digest('hex');
    if (sig !== expected) return res.sendStatus(401);
  }
  try { handleMetaWebhook(req.body || {}); } catch (e) { console.error('webhook', e); }
  res.sendStatus(200);
});

// ---------- front-end
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(/^\/(?!api|media|webhook).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'Arquivo muito grande' : err.message });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno. Tente novamente.' });
});

app.listen(PORT, () => {
  console.log(`Domma Connect Lead rodando em http://localhost:${PORT}`);
  bootConnections();
  startQueue();
});
