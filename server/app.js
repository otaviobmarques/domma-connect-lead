// Rotas da API. Roda na Vercel (api/index.js) e localmente (server/index.js).
import express from 'express';
import cookieParser from 'cookie-parser';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, now, parseJSON } from './db.js';
import { parseSpreadsheet, toXlsxBuffer } from './spreadsheet.js';
import { normalizePhone, formatPhone } from './phone.js';
import { renderMessage, usedVariables } from './render.js';
import { startConnection, logoutConnection, handleMetaWebhook, serverDriver, engineOnline, ENGINE_ONLINE_MS } from './connections.js';
import { tick, reportResult, prepareCampaign, estimateSeconds, contactVars, SPEEDS, hoursLabel } from './dispatch.js';
import { personalize, testAI, encrypt, hasAI, PROVIDERS } from './ai.js';
import { getSettings, saveSettings, DEFAULT_SETTINGS } from './settings.js';
import { createFile, putChunk, completeFile, fileInfo, readFile, readChunk, deleteFile, CHUNK } from './files.js';
import { SECRETS, loadSecrets } from './secrets.js';
import { MODELOS } from './modelos.js';
import { hooks } from './connections.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// link do instalador do app para Windows (Área Privada → App para PC)
export const DESKTOP_DOWNLOAD_URL = process.env.DESKTOP_DOWNLOAD_URL || 'https://github.com/otaviobmarques/domma-connect-lead/releases/latest/download/DommaConnectLead-Setup.exe';
export const DESKTOP_VERSION = process.env.DESKTOP_VERSION || '1.0.1';

export const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '3mb', verify: (req, _res, buf) => { req.rawBody = buf; } }));
app.use(cookieParser());
app.use((req, res, next) => (/^\/(api|media|webhook)\//.test(req.path) ? loadSecrets().then(() => next(), next) : next()));

// ---------- helpers
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const fail = (status, msg) => { throw new HttpError(status, msg); };

const auth = wrap(async (req, res, next) => {
  const token = req.cookies.cl_token || (req.headers.authorization || '').replace(/^Bearer /, '');
  let p;
  try { p = jwt.verify(token, SECRETS.jwt); } catch { return res.status(401).json({ error: 'Faça login novamente' }); }
  req.user = await db.get('SELECT id, name, email, workspace_id, role FROM users WHERE id=?', [p.uid]);
  if (!req.user) return res.status(401).json({ error: 'Faça login novamente' });
  req.ws = req.user.workspace_id;
  next();
});
const signToken = uid => jwt.sign({ uid }, SECRETS.jwt, { expiresIn: '30d' });
function setSession(res, uid) {
  res.cookie('cl_token', signToken(uid), { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 30 * 864e5 });
}
const own = async (table, id, ws) => (await db.get(`SELECT * FROM ${table} WHERE id=? AND workspace_id=?`, [Number(id) || 0, ws])) || fail(404, 'Não encontrado');
const publicConn = c => {
  const cfg = parseJSON(c.config_json, {});
  return { id: c.id, name: c.name, type: c.type, status: c.status, phone: c.phone, phone_fmt: formatPhone(c.phone), created_at: c.created_at,
    last_error: cfg.last_error || null, meta: cfg.meta || null,
    ...(c.type === 'qr' ? { engine_online: !!c.engine_id && engineOnline(c), engine_linked: !!c.engine_id } : {}),
    config: c.type === 'oficial' ? { phone_number_id: cfg.phone_number_id || '', waba_id: cfg.waba_id || '', has_token: !!cfg.access_token } : {} };
};
async function campaignStats(id) {
  const rows = await db.all('SELECT status, COUNT(*) n FROM messages WHERE campaign_id=? GROUP BY status', [id]);
  const s = { total: 0, pendente: 0, enviando: 0, enviado: 0, entregue: 0, lido: 0, falhou: 0, sem_whatsapp: 0, ignorado: 0 };
  for (const r of rows) { s[r.status] = r.n; s.total += r.n; }
  s.respondeu = (await db.get('SELECT COUNT(*) n FROM messages WHERE campaign_id=? AND replied=1', [id])).n;
  s.sucesso = s.enviado + s.entregue + s.lido;
  s.processado = s.total - s.pendente - s.enviando;
  return s;
}
const wsRow = id => db.get('SELECT * FROM workspaces WHERE id=?', [id]);

app.get('/api/health', wrap(async (req, res) => {
  const r = await db.get('SELECT 1 ok');
  res.json({ ok: r.ok === 1 });
}));

// ---------- auth
app.post('/api/auth/register', wrap(async (req, res) => {
  const { name, email, password, company } = req.body || {};
  if (!name || !email || !password) fail(400, 'Preencha nome, e-mail e senha');
  if (password.length < 6) fail(400, 'A senha precisa ter pelo menos 6 caracteres');
  if (await db.get('SELECT 1 FROM users WHERE email=?', [email.toLowerCase()])) fail(400, 'Este e-mail já tem cadastro');
  const hash = await bcrypt.hash(password, 10);
  const uid = await db.tx(async t => {
    const ws = await t.get('INSERT INTO workspaces (name, webhook_token) VALUES (?,?) RETURNING id', [company || name, crypto.randomBytes(12).toString('hex')]);
    return (await t.get('INSERT INTO users (workspace_id, name, email, password_hash) VALUES (?,?,?,?) RETURNING id', [ws.id, name, email.toLowerCase(), hash])).id;
  });
  setSession(res, uid);
  res.json({ ok: true });
}));
app.post('/api/auth/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.get('SELECT * FROM users WHERE email=?', [String(email || '').trim().toLowerCase()]);
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) fail(401, 'Usuário ou senha incorretos');
  setSession(res, u.id);
  res.json({ ok: true });
}));
app.post('/api/auth/logout', (req, res) => { res.clearCookie('cl_token'); res.json({ ok: true }); });
app.get('/api/me', auth, wrap(async (req, res) => {
  const ws = await db.get('SELECT id, name, plan FROM workspaces WHERE id=?', [req.ws]);
  res.json({ user: req.user, workspace: { ...ws, logo: (await getSettings(req.ws)).perfil.logo } });
}));

// ---------- configurações (resumo para o painel) e administrador
app.get('/api/settings', auth, wrap(async (req, res) => {
  const ws = await wsRow(req.ws);
  const st = await getSettings(ws);
  const base = process.env.APP_URL || `${req.protocol}://${req.get('host')}`;
  res.json({ name: st.perfil.nome, logo: st.perfil.logo, optout_footer: st.disparo.rodape_optout, ai_has_key: hasAI(st),
    business_profile: !!(st.perfil.descricao || st.playbook.produtos), gallery: st.galeria, disparo: st.disparo, hours_label: hoursLabel(st.disparo),
    webhook_url: `${base}/webhook/meta`, webhook_token: ws.webhook_token });
}));
async function adminView(wsId) {
  const st = await getSettings(wsId);
  const provs = Object.fromEntries(Object.keys(PROVIDERS).map(k => [k, { label: PROVIDERS[k].label, default_model: PROVIDERS[k].model,
    model: st.ia.provedores?.[k]?.model || '', has_key: !!st.ia.provedores?.[k]?.key || !!process.env[PROVIDERS[k].env] }]));
  return { ...st, ia: { ...st.ia, provedores: provs } };
}
const adminOnly = (req, res, next) => req.user.role === 'owner' ? next() : res.status(403).json({ error: 'Apenas o administrador pode alterar isto' });
app.get('/api/admin', auth, adminOnly, wrap(async (req, res) => res.json(await adminView(req.ws))));
app.patch('/api/admin/:section', auth, adminOnly, wrap(async (req, res) => {
  const sec = req.params.section;
  if (!['perfil', 'playbook', 'ia', 'disparo', 'digitacao'].includes(sec)) fail(400, 'Seção inválida');
  const st = await getSettings(req.ws);
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
  await saveSettings(req.ws, st);
  res.json(await adminView(req.ws));
}));
app.post('/api/admin/test-ai', auth, adminOnly, wrap(async (req, res) => {
  res.json(await testAI(await getSettings(req.ws), req.body?.provider));
}));
app.post('/api/admin/logo', auth, adminOnly, wrap(async (req, res) => {
  const f = await fileInfo(String(req.body?.file || ''), req.ws);
  if (!f || !f.mime.startsWith('image/')) fail(400, 'Envie uma imagem');
  const st = await getSettings(req.ws); st.perfil.logo = f.id; await saveSettings(req.ws, st);
  res.json({ logo: f.id });
}));
app.post('/api/admin/galeria', auth, adminOnly, wrap(async (req, res) => {
  const f = await fileInfo(String(req.body?.file || ''), req.ws);
  if (!f) fail(400, 'Envie um arquivo');
  const st = await getSettings(req.ws);
  st.galeria = [{ file: f.id, mime: f.mime, name: f.name, size: f.size, titulo: String(req.body?.titulo || f.name).slice(0, 80) }, ...st.galeria].slice(0, 200);
  await saveSettings(req.ws, st);
  res.json(st.galeria);
}));
app.delete('/api/admin/galeria/:file', auth, adminOnly, wrap(async (req, res) => {
  const st = await getSettings(req.ws);
  st.galeria = st.galeria.filter(g => g.file !== req.params.file);
  await saveSettings(req.ws, st);
  res.json(st.galeria);
}));
app.post('/api/ai/preview', auth, wrap(async (req, res) => {
  const { message, instructions, list_id } = req.body || {};
  const st = await getSettings(req.ws);
  let contacts = [];
  if (list_id) { await own('lists', list_id, req.ws); contacts = await db.all("SELECT * FROM contacts WHERE list_id=? AND status='valido' ORDER BY row_number LIMIT 3", [list_id]); }
  const sample = contacts.length ? contacts.map(contactVars) : [{ nome: 'Maria Silva', primeiro_nome: 'Maria', telefone: '5531988887777' }];
  const out = await Promise.all(sample.map(async v => {
    try { return { nome: v.nome, telefone: formatPhone(v.telefone), texto: await personalize(st, { base: renderMessage(message, v), instructions, contact: v }) }; }
    catch (e) { return { nome: v.nome, telefone: formatPhone(v.telefone), erro: e.message }; }
  }));
  if (out.every(o => o.erro)) fail(400, out[0].erro);
  res.json({ previews: out });
}));

// ---------- arquivos (envio em pedaços de até 3 MB)
app.post('/api/files', auth, wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await createFile(req.ws, { name: b.name, mime: b.mime, size: b.size, temp: !!b.temp }));
}));
app.put('/api/files/:id/chunk/:idx', auth, express.raw({ type: () => true, limit: CHUNK + 1024 }), wrap(async (req, res) => {
  await putChunk(req.ws, req.params.id, Number(req.params.idx), Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
  res.json({ ok: true });
}));
app.post('/api/files/:id/complete', auth, wrap(async (req, res) => res.json(await completeFile(req.ws, req.params.id))));
// pedaço bruto (usado pelo app do PC para baixar as mídias das campanhas)
app.get('/api/files/:id/chunk/:idx', auth, wrap(async (req, res) => {
  const f = await fileInfo(req.params.id, req.ws);
  if (!f) return res.status(404).end();
  const data = await readChunk(f.id, Number(req.params.idx));
  if (!data) return res.status(404).end();
  res.set({ 'Content-Type': 'application/octet-stream', 'X-File-Chunks': String(f.chunks), 'X-File-Size': String(f.size) });
  res.send(data);
}));
// mídia para o navegador: responde por partes (Range) para respeitar o limite de 4,5 MB da Vercel
app.get('/media/:file', auth, wrap(async (req, res) => {
  const f = await fileInfo(path.basename(req.params.file), req.ws);
  if (!f) return res.status(404).end();
  res.set({ 'Content-Type': f.mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=86400' });
  const m = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
  if (!m && f.size <= CHUNK) return res.send(await readFile(f.id));
  const start = m ? Math.min(Number(m[1]), f.size - 1) : 0;
  const idx = Math.floor(start / CHUNK);
  const chunk = await readChunk(f.id, idx);
  const from = start - idx * CHUNK;
  let end = idx * CHUNK + chunk.length - 1;
  if (m && m[2]) end = Math.min(end, Number(m[2]));
  res.status(206).set('Content-Range', `bytes ${start}-${end}/${f.size}`);
  res.send(chunk.subarray(from, from + (end - start + 1)));
}));

// ---------- conexões
app.get('/api/connections', auth, wrap(async (req, res) => {
  res.json((await db.all('SELECT * FROM connections WHERE workspace_id=? ORDER BY id', [req.ws])).map(publicConn));
}));
app.post('/api/connections', auth, wrap(async (req, res) => {
  const { name, type, config = {} } = req.body || {};
  if (!['qr', 'oficial', 'simulado'].includes(type)) fail(400, 'Tipo de conexão inválido');
  const cfg = type === 'oficial' ? { phone_number_id: String(config.phone_number_id || '').trim(), waba_id: String(config.waba_id || '').trim(), access_token: String(config.access_token || '').trim() } : {};
  const r = await db.get('INSERT INTO connections (workspace_id, name, type, config_json) VALUES (?,?,?,?) RETURNING id',
    [req.ws, name || ({ qr: 'WhatsApp (QR Code)', oficial: 'WhatsApp API Oficial', simulado: 'Conexão de teste' })[type], type, JSON.stringify(cfg)]);
  await startConnection(r.id);
  res.json(publicConn(await db.get('SELECT * FROM connections WHERE id=?', [r.id])));
}));
app.patch('/api/connections/:id', auth, wrap(async (req, res) => {
  const c = await own('connections', req.params.id, req.ws);
  const cfg = parseJSON(c.config_json, {});
  const { name, config } = req.body || {};
  if (config && c.type === 'oficial') {
    for (const k of ['phone_number_id', 'waba_id', 'access_token']) if (config[k]) cfg[k] = String(config[k]).trim();
  }
  await db.run('UPDATE connections SET name=COALESCE(?,name), config_json=? WHERE id=?', [name || null, JSON.stringify(cfg), c.id]);
  if (config && c.type === 'oficial') await startConnection(c.id);
  res.json(publicConn(await db.get('SELECT * FROM connections WHERE id=?', [c.id])));
}));
app.post('/api/connections/:id/connect', auth, wrap(async (req, res) => {
  const c = await own('connections', req.params.id, req.ws);
  await startConnection(c.id);
  res.json({ ok: true });
}));
app.get('/api/connections/:id/qr', auth, wrap(async (req, res) => {
  const c = await own('connections', req.params.id, req.ws);
  res.json({ status: c.status, qr: c.status === 'aguardando_qr' ? c.qr : null, phone_fmt: formatPhone(c.phone), last_error: parseJSON(c.config_json, {}).last_error || null,
    engine_online: engineOnline(c) || !!(await anyEngineOnline(req.ws)) });
}));
app.post('/api/connections/:id/disconnect', auth, wrap(async (req, res) => {
  const c = await own('connections', req.params.id, req.ws);
  await logoutConnection(c.id);
  res.json({ ok: true });
}));
app.delete('/api/connections/:id', auth, wrap(async (req, res) => {
  const c = await own('connections', req.params.id, req.ws);
  if (await db.get("SELECT 1 FROM campaigns WHERE connection_id=? AND status IN ('enviando','agendada','pausada')", [c.id])) fail(400, 'Há campanhas ativas usando esta conexão. Cancele-as antes.');
  await logoutConnection(c.id).catch(() => {});
  // QR Code: o app do PC encerra a sessão quando vê want='logout' na conexão removida
  await db.run("UPDATE connections SET status='removida', want='logout', workspace_id=-workspace_id WHERE id=?", [c.id]);
  res.json({ ok: true });
}));
app.get('/api/connections/:id/templates', auth, wrap(async (req, res) => {
  const c = await own('connections', req.params.id, req.ws);
  if (c.type !== 'oficial') fail(400, 'Modelos só existem na API Oficial');
  const list = await serverDriver(c).templates();
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
async function importRows(listId, ws, rows, phoneColumn, nameColumn, defaultDDD) {
  const seen = new Set(); let valid = 0, invalid = 0, dup = 0;
  const out = rows.map((r, i) => {
    const n = phoneColumn ? normalizePhone(r[phoneColumn], { defaultDDD }) : { ok: false, error: 'Coluna de telefone não escolhida' };
    let status = 'valido', error = null; const phone = n.ok ? n.phone : String(r[phoneColumn] ?? '');
    if (!n.ok) { status = 'invalido'; error = n.error; invalid++; }
    else if (seen.has(n.phone)) { status = 'duplicado'; error = 'Telefone repetido na planilha'; dup++; }
    else { seen.add(n.phone); valid++; }
    return [i + 2, phone, nameColumn ? String(r[nameColumn] || '') : '', JSON.stringify(r), status, error];
  });
  await db.tx(async t => {
    await t.run('DELETE FROM contacts WHERE list_id=?', [listId]);
    for (let i = 0; i < out.length; i += 5000) {
      const part = out.slice(i, i + 5000);
      const col = k => part.map(r => r[k]);
      await t.run(`INSERT INTO contacts (list_id, workspace_id, row_number, phone, name, data_json, status, error)
        SELECT ?, ?, * FROM unnest(?::int[], ?::text[], ?::text[], ?::text[], ?::text[], ?::text[])`,
        [listId, ws, col(0), col(1), col(2), col(3), col(4), col(5)]);
    }
    await t.run('UPDATE lists SET phone_column=?, name_column=?, total=?, valid=?, invalid=?, duplicates=? WHERE id=?',
      [phoneColumn, nameColumn, rows.length, valid, invalid, dup, listId]);
  });
}
const contactOut = c => ({ ...c, data: parseJSON(c.data_json, {}), data_json: undefined, phone_fmt: c.status === 'invalido' ? c.phone : formatPhone(c.phone) });
async function listSummary(id) {
  const l = await db.get('SELECT * FROM lists WHERE id=?', [id]);
  const optouts = (await db.get(`SELECT COUNT(*) n FROM contacts c JOIN optouts o ON o.phone=c.phone AND o.workspace_id=c.workspace_id WHERE c.list_id=? AND c.status='valido'`, [id])).n;
  const preview = (await db.all('SELECT row_number, phone, name, data_json, status, error FROM contacts WHERE list_id=? ORDER BY row_number LIMIT 8', [id])).map(contactOut);
  return { ...l, columns: parseJSON(l.columns_json, []), columns_json: undefined, optouts, preview };
}
app.post('/api/lists/import', auth, wrap(async (req, res) => {
  const f = await fileInfo(String(req.body?.file || ''), req.ws);
  if (!f) fail(400, 'Envie uma planilha (.xlsx, .xls ou .csv)');
  let parsed;
  try { parsed = parseSpreadsheet(await readFile(f.id), f.name); } catch (e) { await deleteFile(f.id); fail(400, 'Não consegui ler a planilha: ' + e.message); }
  await deleteFile(f.id);
  if (!parsed.rows.length) fail(400, 'A planilha não tem linhas com dados');
  if (parsed.rows.length > 100000) fail(400, 'Limite de 100.000 linhas por planilha');
  const name = String(req.body.name || f.name.replace(/\.[^.]+$/, '')).slice(0, 120);
  const r = await db.get('INSERT INTO lists (workspace_id, name, columns_json) VALUES (?,?,?) RETURNING id', [req.ws, name, JSON.stringify(parsed.columns)]);
  await importRows(r.id, req.ws, parsed.rows, parsed.phoneColumn, parsed.nameColumn, req.body.defaultDDD || null);
  res.json(await listSummary(r.id));
}));
app.post('/api/lists/:id/remap', auth, wrap(async (req, res) => {
  const l = await own('lists', req.params.id, req.ws);
  const rows = (await db.all('SELECT data_json FROM contacts WHERE list_id=? ORDER BY row_number', [l.id])).map(c => parseJSON(c.data_json, {}));
  const { phoneColumn, nameColumn, defaultDDD } = req.body || {};
  await importRows(l.id, req.ws, rows, phoneColumn || null, nameColumn || null, defaultDDD || null);
  res.json(await listSummary(l.id));
}));
app.get('/api/lists', auth, wrap(async (req, res) => {
  res.json((await db.all('SELECT id, name, total, valid, invalid, duplicates, created_at, columns_json FROM lists WHERE workspace_id=? ORDER BY id DESC', [req.ws]))
    .map(l => ({ ...l, columns: parseJSON(l.columns_json, []), columns_json: undefined })));
}));
app.get('/api/lists/:id', auth, wrap(async (req, res) => {
  const l = await own('lists', req.params.id, req.ws);
  const page = Math.max(1, Number(req.query.page) || 1), per = 50;
  const st = req.query.status;
  const where = st ? 'AND status=?' : '';
  const args = st ? [l.id, st] : [l.id];
  const contacts = (await db.all(`SELECT row_number, phone, name, data_json, status, error FROM contacts WHERE list_id=? ${where} ORDER BY row_number LIMIT ${per} OFFSET ${(page - 1) * per}`, args)).map(contactOut);
  const count = (await db.get(`SELECT COUNT(*) n FROM contacts WHERE list_id=? ${where}`, args)).n;
  res.json({ ...(await listSummary(l.id)), contacts, page, pages: Math.max(1, Math.ceil(count / per)) });
}));
app.get('/api/lists/:id/export', auth, wrap(async (req, res) => {
  const l = await own('lists', req.params.id, req.ws);
  const st = req.query.status;
  const rows = (await db.all(`SELECT * FROM contacts WHERE list_id=? ${st ? 'AND status=?' : ''} ORDER BY row_number`, st ? [l.id, st] : [l.id]))
    .map(c => ({ Linha: c.row_number, Situação: c.status, Motivo: c.error || '', 'Telefone tratado': c.status === 'valido' ? c.phone : '', ...parseJSON(c.data_json, {}) }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="lista-${l.id}${st ? '-' + st : ''}.xlsx"`);
  res.send(toXlsxBuffer(rows, 'Contatos'));
}));
app.delete('/api/lists/:id', auth, wrap(async (req, res) => {
  const l = await own('lists', req.params.id, req.ws);
  if (await db.get('SELECT 1 FROM campaigns WHERE list_id=?', [l.id])) fail(400, 'Esta lista já foi usada em campanhas e não pode ser apagada');
  await db.run('DELETE FROM lists WHERE id=?', [l.id]);
  res.json({ ok: true });
}));

// ---------- modelos / prévia / estimativa
app.get('/api/modelos', auth, (req, res) => res.json(MODELOS));
app.post('/api/preview', auth, wrap(async (req, res) => {
  const { message, list_id, add_optout_footer } = req.body || {};
  const footer = (await getSettings(req.ws)).disparo.rodape_optout;
  let contacts = [], list = null;
  if (list_id) { list = await own('lists', list_id, req.ws); contacts = await db.all("SELECT * FROM contacts WHERE list_id=? AND status='valido' ORDER BY row_number LIMIT 3", [list_id]); }
  const sample = contacts.length ? contacts.map(contactVars) : [{ nome: 'Maria Silva', primeiro_nome: 'Maria', telefone: '5531988887777' }];
  const out = sample.map(v => {
    let t = renderMessage(message, v);
    if (add_optout_footer && footer) t += `\n\n_${footer}_`;
    return { nome: v.nome, telefone: formatPhone(v.telefone), texto: t };
  });
  const known = new Set(['nome', 'primeiro_nome', 'telefone', 'saudacao', ...parseJSON(list?.columns_json, []).map(c => c.key)]);
  res.json({ previews: out, unknown_vars: [...new Set(usedVariables(message))].filter(v => !known.has(v)) });
}));
app.post('/api/estimate', auth, wrap(async (req, res) => {
  const { connection_id, speed, count, custom } = req.body || {};
  const c = connection_id ? await own('connections', connection_id, req.ws) : { type: 'qr' };
  res.json({ seconds: estimateSeconds(c.type, speed, Number(count) || 0, custom || {}), speeds: SPEEDS[c.type] });
}));

// ---------- campanhas
app.get('/api/campaigns', auth, wrap(async (req, res) => {
  const rows = await db.all(`SELECT c.*, l.name list_name, n.name connection_name, n.type connection_type FROM campaigns c
    JOIN lists l ON l.id=c.list_id JOIN connections n ON n.id=c.connection_id WHERE c.workspace_id=? ORDER BY c.id DESC`, [req.ws]);
  res.json(await Promise.all(rows.map(async c => ({ ...c, stats: await campaignStats(c.id) }))));
}));
app.post('/api/campaigns', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const list = await own('lists', b.list_id, req.ws);
  const conn = await own('connections', b.connection_id, req.ws);
  if (!b.name) fail(400, 'Dê um nome para a campanha');
  if (list.valid === 0) fail(400, 'A lista não tem nenhum telefone válido');
  const mode = conn.type === 'oficial' && b.mode === 'template' ? 'template' : 'texto';
  const aiOn = mode === 'texto' && !!b.ai_enabled;
  if (mode === 'texto' && !String(b.message || '').trim() && !b.media_file && !(aiOn && String(b.ai_instructions || '').trim())) fail(400, 'Escreva a mensagem');
  if (aiOn && !hasAI(await getSettings(req.ws))) fail(400, 'Configure uma IA no Administrador antes de usar a personalização');
  if (b.media_file && !(await fileInfo(String(b.media_file), req.ws))) fail(400, 'O anexo não foi encontrado. Envie o arquivo de novo.');
  const speed = ['segura', 'normal', 'rapida', 'personalizado'].includes(b.speed) ? b.speed : 'segura';
  const cmin = Math.max(1, Math.round(Number(b.custom_min) || 0)), cmax = Math.round(Number(b.custom_max) || 0);
  if (speed === 'personalizado' && (!b.custom_min || cmax < cmin)) fail(400, 'No intervalo personalizado, o máximo precisa ser maior ou igual ao mínimo');
  if (mode === 'template' && !b.template_name) fail(400, 'Escolha o modelo aprovado pela Meta');
  const scheduled = b.scheduled_at ? new Date(b.scheduled_at) : null;
  if (scheduled && isNaN(scheduled)) fail(400, 'Data de agendamento inválida');
  const status = b.start === false ? 'rascunho' : scheduled && scheduled > new Date() ? 'agendada' : 'enviando';
  const r = await db.get(`INSERT INTO campaigns (workspace_id, name, list_id, connection_id, mode, message, media_file, media_type, media_name,
    template_name, template_lang, template_params_json, add_optout_footer, speed, business_hours, scheduled_at, status, started_at,
    custom_min, custom_max, custom_every, custom_pause, ai_enabled, ai_instructions)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) RETURNING id`, [req.ws, b.name, list.id, conn.id, mode, b.message || '', b.media_file || null, b.media_type || null, b.media_name || null,
    b.template_name || null, b.template_lang || null, JSON.stringify(b.template_params || {}), b.add_optout_footer === false ? 0 : 1,
    speed, b.business_hours === false ? 0 : 1,
    scheduled ? scheduled.toISOString() : null, status, status === 'enviando' ? now() : null,
    speed === 'personalizado' ? cmin : null, speed === 'personalizado' ? cmax : null,
    speed === 'personalizado' ? (Math.round(Number(b.custom_every)) || null) : null, speed === 'personalizado' ? (Math.round(Number(b.custom_pause)) || null) : null,
    aiOn ? 1 : 0, aiOn ? String(b.ai_instructions || '') : null]);
  if (status === 'enviando') await prepareCampaign(r.id);
  res.json({ id: r.id, status });
}));
app.get('/api/campaigns/:id', auth, wrap(async (req, res) => {
  const c = await own('campaigns', req.params.id, req.ws);
  const list = await db.get('SELECT id, name, valid FROM lists WHERE id=?', [c.list_id]);
  const conn = await db.get('SELECT * FROM connections WHERE id=?', [c.connection_id]);
  const stats = await campaignStats(c.id);
  const remaining = stats.total ? stats.pendente : list.valid;
  res.json({ ...c, template_params: parseJSON(c.template_params_json, {}), list: { id: list.id, name: list.name }, connection: publicConn(conn), stats,
    eta_seconds: ['enviando', 'pausada', 'agendada'].includes(c.status) ? estimateSeconds(conn.type, c.speed, remaining, c) : 0 });
}));
app.get('/api/campaigns/:id/messages', auth, wrap(async (req, res) => {
  const c = await own('campaigns', req.params.id, req.ws);
  const page = Math.max(1, Number(req.query.page) || 1), per = 50;
  const st = req.query.status;
  let where = ''; const args = [c.id];
  if (st === 'sucesso') where = "AND status IN ('enviado','entregue','lido')";
  else if (st === 'respondeu') where = 'AND replied=1';
  else if (st === 'erro') where = "AND status IN ('falhou','sem_whatsapp')";
  else if (st) { where = 'AND status=?'; args.push(st); }
  const rows = (await db.all(`SELECT id, phone, name, status, error, sent_at, replied, reply_text, rendered FROM messages WHERE campaign_id=? ${where} ORDER BY id LIMIT ${per} OFFSET ${(page - 1) * per}`, args))
    .map(m => ({ ...m, phone_fmt: formatPhone(m.phone) }));
  const count = (await db.get(`SELECT COUNT(*) n FROM messages WHERE campaign_id=? ${where}`, args)).n;
  res.json({ rows, page, pages: Math.max(1, Math.ceil(count / per)), count });
}));
app.post('/api/campaigns/:id/:action', auth, wrap(async (req, res) => {
  const a = req.params.action;
  if (!['pause', 'resume', 'cancel', 'start', 'retry'].includes(a)) fail(404, 'Ação desconhecida');
  const c = await own('campaigns', req.params.id, req.ws);
  if (a === 'pause' && ['enviando', 'agendada'].includes(c.status)) await db.run("UPDATE campaigns SET status='pausada', pause_reason='Pausada por você' WHERE id=?", [c.id]);
  else if ((a === 'resume' || a === 'start') && ['pausada', 'rascunho'].includes(c.status)) {
    await prepareCampaign(c.id);
    await db.run("UPDATE campaigns SET status='enviando', next_send_at=0, pause_reason=NULL, started_at=COALESCE(started_at, ?) WHERE id=?", [now(), c.id]);
  } else if (a === 'cancel' && !['concluida', 'cancelada'].includes(c.status)) {
    await db.run("UPDATE messages SET status='ignorado', error='Campanha cancelada' WHERE campaign_id=? AND status='pendente'", [c.id]);
    await db.run("UPDATE campaigns SET status='cancelada', finished_at=?, pause_reason=NULL WHERE id=?", [now(), c.id]);
  } else if (a === 'retry') {
    const n = (await db.run("UPDATE messages SET status='pendente', error=NULL, attempts=0 WHERE campaign_id=? AND status='falhou'", [c.id])).changes;
    if (!n) fail(400, 'Não há envios com falha para tentar de novo');
    await db.run("UPDATE campaigns SET status='enviando', next_send_at=0, finished_at=NULL, pause_reason=NULL WHERE id=?", [c.id]);
  } else fail(400, 'Ação não permitida no status atual');
  res.json({ ok: true });
}));
app.get('/api/campaigns/:id/export', auth, wrap(async (req, res) => {
  const c = await own('campaigns', req.params.id, req.ws);
  const label = { pendente: 'Na fila', enviando: 'Enviando', enviado: 'Enviado', entregue: 'Entregue', lido: 'Lido', falhou: 'Falhou', sem_whatsapp: 'Sem WhatsApp', ignorado: 'Não enviado' };
  const rows = (await db.all('SELECT * FROM messages WHERE campaign_id=? ORDER BY id', [c.id])).map(m => ({
    Nome: m.name || '', Telefone: formatPhone(m.phone), Situação: label[m.status] || m.status, Motivo: m.error || '',
    'Enviado em': m.sent_at ? new Date(m.sent_at).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
    Respondeu: m.replied ? 'Sim' : 'Não', Resposta: m.reply_text || '', Mensagem: m.rendered || '',
  }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="campanha-${c.id}.xlsx"`);
  res.send(toXlsxBuffer(rows));
}));
app.delete('/api/campaigns/:id', auth, wrap(async (req, res) => {
  const c = await own('campaigns', req.params.id, req.ws);
  if (['enviando', 'agendada'].includes(c.status)) fail(400, 'Pause ou cancele a campanha antes de apagar');
  await db.run('DELETE FROM campaigns WHERE id=?', [c.id]);
  res.json({ ok: true });
}));

// ---------- painel
app.get('/api/dashboard', auth, wrap(async (req, res) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const m = await db.get(`SELECT
      SUM(CASE WHEN m.status IN ('enviado','entregue','lido') THEN 1 ELSE 0 END) enviados,
      SUM(CASE WHEN m.status IN ('entregue','lido') THEN 1 ELSE 0 END) entregues,
      SUM(CASE WHEN m.status='lido' THEN 1 ELSE 0 END) lidos,
      SUM(m.replied) respostas,
      SUM(CASE WHEN m.status IN ('falhou','sem_whatsapp') THEN 1 ELSE 0 END) erros
    FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE c.workspace_id=? AND COALESCE(m.sent_at, m.updated_at) >= ?`, [req.ws, since]);
  const daily = await db.all(`SELECT substr(m.sent_at,1,10) dia, COUNT(*) n FROM messages m JOIN campaigns c ON c.id=m.campaign_id
    WHERE c.workspace_id=? AND m.sent_at >= ? GROUP BY dia ORDER BY dia`, [req.ws, new Date(Date.now() - 14 * 864e5).toISOString()]);
  const active = await Promise.all((await db.all("SELECT id, name, status, pause_reason FROM campaigns WHERE workspace_id=? AND status IN ('enviando','agendada','pausada') ORDER BY id DESC", [req.ws]))
    .map(async c => ({ ...c, stats: await campaignStats(c.id) })));
  const conns = (await db.all('SELECT * FROM connections WHERE workspace_id=?', [req.ws])).map(publicConn);
  const optouts = (await db.get('SELECT COUNT(*) n FROM optouts WHERE workspace_id=?', [req.ws])).n;
  res.json({ metrics: { enviados: m.enviados || 0, entregues: m.entregues || 0, lidos: m.lidos || 0, respostas: m.respostas || 0, erros: m.erros || 0, optouts }, daily, active, connections: conns,
    lists: (await db.get('SELECT COUNT(*) n FROM lists WHERE workspace_id=?', [req.ws])).n, engine: await engineStatus(req.ws) });
}));

// ---------- descadastrados (opt-out)
app.get('/api/optouts', auth, wrap(async (req, res) => {
  res.json((await db.all('SELECT phone, reason, created_at FROM optouts WHERE workspace_id=? ORDER BY created_at DESC', [req.ws])).map(o => ({ ...o, phone_fmt: formatPhone(o.phone) })));
}));
app.post('/api/optouts', auth, wrap(async (req, res) => {
  const n = normalizePhone(req.body?.phone);
  if (!n.ok) fail(400, n.error);
  await db.run('INSERT INTO optouts (workspace_id, phone, reason) VALUES (?,?,?) ON CONFLICT DO NOTHING', [req.ws, n.phone, 'Adicionado manualmente']);
  res.json({ ok: true });
}));
app.delete('/api/optouts/:phone', auth, wrap(async (req, res) => {
  await db.run('DELETE FROM optouts WHERE workspace_id=? AND phone=?', [req.ws, req.params.phone]);
  res.json({ ok: true });
}));

// ---------- fila e app do PC (motor de envio)
const anyEngineOnline = ws => db.get('SELECT id FROM engines WHERE workspace_id=? AND last_seen > ? LIMIT 1', [ws, Date.now() - ENGINE_ONLINE_MS]);
async function engineStatus(ws) {
  const rows = await db.all('SELECT id, name, version, last_seen FROM engines WHERE workspace_id=? ORDER BY last_seen DESC LIMIT 5', [ws]);
  return { online: rows.some(r => Date.now() - r.last_seen < ENGINE_ONLINE_MS), engines: rows.map(r => ({ ...r, online: Date.now() - r.last_seen < ENGINE_ONLINE_MS })),
    download_url: '/api/download/windows', version: DESKTOP_VERSION };
}
// painel aberto no navegador: avança envios da API Oficial e da conexão de teste
app.post('/api/queue/tick', auth, wrap(async (req, res) => { await tick(req.ws, null); res.json({ ok: true }); }));
app.get('/api/engine/status', auth, wrap(async (req, res) => res.json(await engineStatus(req.ws))));
// login do app do PC (devolve token para o cabeçalho Authorization)
app.post('/api/engine/login', wrap(async (req, res) => {
  const { email, password } = req.body || {};
  const u = await db.get('SELECT * FROM users WHERE email=?', [String(email || '').trim().toLowerCase()]);
  if (!u || !(await bcrypt.compare(password || '', u.password_hash))) fail(401, 'Usuário ou senha incorretos');
  res.json({ token: signToken(u.id), user: { name: u.name, email: u.email } });
}));
app.post('/api/engine/tick', auth, wrap(async (req, res) => {
  const b = req.body || {};
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(String(b.engine_id || ''))) fail(400, 'engine_id inválido');
  const out = await tick(req.ws, { id: b.engine_id, name: b.name, version: b.version, user_id: req.user.id,
    connections: (Array.isArray(b.connections) ? b.connections : []).map(c => ({ id: Number(c.id), status: String(c.status || ''), phone: c.phone ? String(c.phone) : null, qr: c.qr ? String(c.qr).slice(0, 20000) : null, error: c.error ? String(c.error).slice(0, 300) : null })) });
  res.json({ ...out, latest_version: DESKTOP_VERSION });
}));
app.post('/api/engine/result', auth, wrap(async (req, res) => {
  const b = req.body || {};
  res.json(await reportResult(req.ws, String(b.engine_id || ''), b));
}));
app.post('/api/engine/events', auth, wrap(async (req, res) => {
  const b = req.body || {};
  const mine = new Set((await db.all("SELECT id FROM connections WHERE workspace_id=? AND type='qr' AND engine_id=?", [req.ws, String(b.engine_id || '')])).map(r => r.id));
  for (const e of (Array.isArray(b.events) ? b.events : []).slice(0, 500)) {
    if (e.type === 'status') {
      // só mensagens desta empresa
      const ok = await db.get('SELECT 1 FROM messages m JOIN campaigns c ON c.id=m.campaign_id WHERE m.wa_message_id=? AND c.workspace_id=?', [String(e.wa_id || ''), req.ws]);
      if (ok) await hooks.onStatus(String(e.wa_id), String(e.status), e.error);
    } else if (e.type === 'incoming' && mine.has(Number(e.connection_id))) {
      await hooks.onIncoming(Number(e.connection_id), String(e.phone || '').replace(/\D/g, ''), String(e.text || '').slice(0, 2000));
    }
  }
  res.json({ ok: true });
}));
app.get('/api/download/windows', auth, (req, res) => res.redirect(DESKTOP_DOWNLOAD_URL));

// ---------- webhook da Meta (API Oficial)
app.get('/webhook/meta', wrap(async (req, res) => {
  const token = req.query['hub.verify_token'];
  const valid = token && (token === process.env.META_VERIFY_TOKEN || await db.get('SELECT 1 FROM workspaces WHERE webhook_token=?', [token]));
  if (req.query['hub.mode'] === 'subscribe' && valid) return res.send(req.query['hub.challenge']);
  res.sendStatus(403);
}));
app.post('/webhook/meta', wrap(async (req, res) => {
  if (process.env.META_APP_SECRET) {
    const sig = req.get('x-hub-signature-256') || '';
    const expected = 'sha256=' + crypto.createHmac('sha256', process.env.META_APP_SECRET).update(req.rawBody || '').digest('hex');
    if (sig.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) return res.sendStatus(401);
  }
  try { await handleMetaWebhook(req.body || {}); } catch (e) { console.error('webhook', e); }
  res.sendStatus(200);
}));

// ---------- front-end (localmente; na Vercel os arquivos de public/ são servidos direto)
app.use(express.static(path.join(__dirname, '..', 'public')));
app.get(/^\/(?!api|media|webhook).*/, (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(400).json({ error: 'Arquivo muito grande' });
  if (!err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : 'Erro interno. Tente novamente.' });
});

export default app;
