// Domma Connect Lead — painel
const root = document.getElementById('root');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const fmtN = n => Number(n || 0).toLocaleString('pt-BR');
const pct = (a, b) => b ? Math.round(a / b * 100) : 0;
const toDate = s => new Date(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d$/.test(s) ? s.replace(' ', 'T') + 'Z' : s);
const fmtDate = s => s ? toDate(s).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';
function fmtDur(sec) {
  sec = Math.round(sec || 0);
  if (sec < 60) return `${sec} s`;
  const m = Math.round(sec / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  if (h < 24) return `${h} h${r ? ' ' + r + ' min' : ''}`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
// formatação estilo WhatsApp para a prévia
const waFormat = t => esc(t).replace(/\*([^*\n]+)\*/g, '<b>$1</b>').replace(/(^|\s)_([^_\n]+)_/g, '$1<i>$2</i>').replace(/~([^~\n]+)~/g, '<s>$1</s>');

async function api(path, opts = {}) {
  const o = { method: opts.method || (opts.body ? 'POST' : 'GET'), headers: {} };
  if (opts.body instanceof FormData) o.body = opts.body;
  else if (opts.body) { o.body = JSON.stringify(opts.body); o.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(path, o);
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !path.startsWith('/api/auth')) { me = null; location.hash = '#/login'; throw new Error(j.error || 'Sessão expirada'); }
  if (!r.ok) throw new Error(j.error || 'Algo deu errado');
  return j;
}
// envia arquivos em pedaços de 3 MB (limite de 4,5 MB por requisição na Vercel)
async function uploadFile(f, { temp = false, onProgress } = {}) {
  const meta = await api('/api/files', { body: { name: f.name, mime: f.type || 'application/octet-stream', size: f.size, temp } });
  for (let i = 0; i < meta.chunks; i++) {
    const part = f.slice(i * meta.chunk_size, (i + 1) * meta.chunk_size);
    const r = await fetch(`/api/files/${meta.id}/chunk/${i}`, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: part });
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Falha ao enviar o arquivo');
    onProgress && onProgress((i + 1) / meta.chunks);
  }
  return api(`/api/files/${meta.id}/complete`, { method: 'POST' });
}
const IN_DESKTOP = /DommaConnectLead/.test(navigator.userAgent);
// painel aberto: faz a fila andar para a API Oficial e a conexão de teste
setInterval(() => { if (me && document.visibilityState === 'visible') fetch('/api/queue/tick', { method: 'POST' }).catch(() => {}); }, 4000);

function toast(msg, err) {
  const t = document.createElement('div');
  t.className = 'toast' + (err ? ' err' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 4200);
}
const safe = fn => async (...a) => { try { await fn(...a); } catch (e) { toast(e.message, true); } };

let timers = [];
function every(fn, ms) { const run = safe(fn); run(); timers.push(setInterval(run, ms)); }
function clearTimers() { timers.forEach(clearInterval); timers = []; }

function modal(html, { wide } = {}) {
  const bg = document.createElement('div');
  bg.className = 'modalbg';
  bg.innerHTML = `<div class="modal ${wide ? 'wide' : ''}">${html}</div>`;
  const close = () => { bg.remove(); bg.onclose?.(); };
  bg.addEventListener('mousedown', e => { if (e.target === bg) close(); });
  bg.addEventListener('click', e => { if (e.target.closest('[data-close]')) close(); });
  document.body.append(bg);
  bg.close = close;
  return bg;
}

const CAMP_STATUS = {
  rascunho: ['plain', 'Rascunho'], agendada: ['info', 'Agendada'], enviando: ['roxo', 'Enviando'],
  pausada: ['warn', 'Pausada'], concluida: ['ok', 'Concluída'], cancelada: ['err', 'Cancelada'],
};
const MSG_STATUS = {
  pendente: ['plain', 'Na fila'], enviando: ['roxo', 'Enviando'], enviado: ['info', 'Enviado'], entregue: ['ok', 'Entregue'],
  lido: ['ok', 'Lido'], falhou: ['err', 'Falhou'], sem_whatsapp: ['warn', 'Sem WhatsApp'], ignorado: ['plain', 'Não enviado'],
};
const CONN_STATUS = {
  conectado: ['ok', 'Conectado'], aguardando_qr: ['warn', 'Aguardando QR Code'], reconectando: ['warn', 'Reconectando…'],
  desconectado: ['plain', 'Desconectado'], erro: ['err', 'Com erro'],
};
const CONN_TYPE = { qr: ['📱', 'QR Code'], oficial: ['✅', 'API Oficial'], simulado: ['🧪', 'Teste'] };
const badge = (map, k) => { const [c, l] = map[k] || ['plain', k]; return `<span class="badge ${c}">${esc(l)}</span>`; };

function progressBar(s, big) {
  const t = s.total || 1;
  return `<div class="bar ${big ? 'big' : ''}"><i class="s" style="width:${s.sucesso / t * 100}%"></i><i class="e" style="width:${(s.falhou + s.sem_whatsapp) / t * 100}%"></i><i class="g" style="width:${s.ignorado / t * 100}%"></i></div>`;
}

// anel animado: a fase da animação vem do relógio, então re-renderizar a cada 3s não “pula”
const lastPct = {};
function ring(key, pctNow, status, size = 190) {
  const sw = size > 100 ? 13 : 7, r = (size - sw) / 2 - (size > 100 ? 6 : 2), C = 2 * Math.PI * r;
  const from = lastPct[key] ?? pctNow; lastPct[key] = pctNow;
  const spinning = ['enviando', 'agendada'].includes(status);
  const delay = `-${(Date.now() % 1800) / 1000}s`, wdelay = `-${(Date.now() % 1600) / 1000}s`;
  const label = { enviando: 'enviando', agendada: 'agendada', pausada: 'pausada', concluida: 'concluída', cancelada: 'cancelada', rascunho: 'rascunho' }[status] || '';
  const color = status === 'concluida' ? 'var(--verde)' : status === 'pausada' ? '#eab308' : status === 'cancelada' ? 'var(--vermelho)' : `url(#g${key})`;
  const id = `ring-${key}`;
  requestAnimationFrame(() => { const c = document.querySelector(`#${id} .prg`); if (c) c.style.strokeDashoffset = C * (1 - pctNow / 100); });
  return `<div class="ring ${status}" id="${id}" style="width:${size}px;height:${size}px">
    ${spinning && size > 100 ? `<div class="halo" style="animation-delay:${delay}"></div>` : ''}
    <svg width="${size}" height="${size}"><defs><linearGradient id="g${key}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#8d7eff"/><stop offset="1" stop-color="#5a47f0"/></linearGradient></defs>
      <circle class="trk" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke-width="${sw}"/>
      <circle class="prg" cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="${sw}" stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - from / 100)}"/></svg>
    ${spinning ? `<div class="orbit" style="animation-delay:${delay}"><svg width="${size}" height="${size}"><defs><linearGradient id="t${key}" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#6b59fe" stop-opacity="0"/><stop offset="1" stop-color="#6b59fe"/></linearGradient></defs>
      <path d="M ${size / 2} ${size / 2 - r} A ${r} ${r} 0 0 1 ${size / 2 + r * Math.sin(1)} ${size / 2 - r * Math.cos(1)}" fill="none" stroke="url(#t${key})" stroke-width="${sw}" stroke-linecap="round" opacity=".55"/>
      <circle cx="${size / 2 + r * Math.sin(1)}" cy="${size / 2 - r * Math.cos(1)}" r="${sw / 2 + (size > 100 ? 3 : 1)}" fill="#fff" stroke="#6b59fe" stroke-width="${size > 100 ? 4 : 2}"/></svg></div>` : ''}
    <div class="ctr">${size > 100 ? (status === 'concluida' ? '<div style="font-size:28px;margin-bottom:4px">✅</div>' : `<img class="wave" src="/brand/simbolo.png" style="height:22px;animation-delay:${wdelay};${spinning ? '' : 'animation:none;opacity:.6'}" alt="">`) : ''}
      <div class="pc" style="font-size:${size > 100 ? 40 : 14}px">${pctNow}%</div>${size > 100 ? `<div class="lb" style="font-size:11px">${label}</div>` : ''}</div></div>`;
}

// ---------------------------------------------------------------- app shell
let me = null;
const NAV = [
  ['#/', '🏠', 'Início'], ['#/campanhas', '📣', 'Campanhas'], ['#/listas', '📋', 'Listas de contatos'],
  ['#/conexoes', '🔌', 'Conexões'], ['#/descadastrados', '🚫', 'Descadastrados'], ['#/app', '💻', 'App para PC'], ['#/admin', '🛠️', 'Administrador'],
];
function shell() {
  const h = location.hash || '#/';
  root.innerHTML = `
  <div class="mobilebar"><div class="brand sm"><img class="sym" src="/brand/simbolo-branco.png" alt=""><div><img class="word" src="/brand/domma-branco.png" alt="Domma"><div class="prod">CONNECT LEAD</div></div></div><button class="btn sm" id="menuBtn">☰</button></div>
  <div class="app">
    <aside class="side" id="side">
      <div class="brand"><img class="sym" src="/brand/simbolo-branco.png" alt=""><div><img class="word" src="/brand/domma-branco.png" alt="Domma"><div class="prod">CONNECT LEAD</div></div></div>
      ${me.workspace.logo ? `<div class="row" style="gap:10px;padding:0 8px 14px"><img src="/media/${esc(me.workspace.logo)}" style="width:34px;height:34px;border-radius:9px;object-fit:cover;background:#fff"><span class="small" style="opacity:.9">${esc(me.workspace.name)}</span></div>` : ''}
      <a class="btn cta" href="#/nova">＋ Nova campanha</a>
      <nav class="nav">${NAV.map(([href, ic, l]) => `<a href="${href}" class="${(href === '#/' ? h === '#/' || h === '' : h.startsWith(href)) ? 'on' : ''}"><span class="ico">${ic}</span>${l}</a>`).join('')}</nav>
      <div class="foot"><b>${esc(me.workspace.name)}</b>${esc(me.user.email)}<br><a href="#" id="logout" style="color:#fff;opacity:.8">Sair</a></div>
    </aside>
    <main class="main" id="page"></main>
  </div>`;
  $('#logout').onclick = safe(async e => { e.preventDefault(); await api('/api/auth/logout', { method: 'POST' }); me = null; location.hash = '#/login'; });
  $('#menuBtn').onclick = () => $('#side').classList.toggle('open');
  return $('#page');
}

const routes = [
  [/^#\/login$/, pageLogin, true], [/^#\/cadastro$/, pageRegister, true],
  [/^#\/?$/, pageHome], [/^#\/nova$/, pageWizard], [/^#\/campanhas$/, pageCampaigns], [/^#\/campanhas\/(\d+)$/, pageCampaign],
  [/^#\/listas$/, pageLists], [/^#\/listas\/(\d+)$/, pageList], [/^#\/conexoes$/, pageConnections],
  [/^#\/descadastrados$/, pageOptouts], [/^#\/app$/, pageDesktop], [/^#\/(admin|config)(?:\/(\w+))?$/, pageAdmin],
];
async function router() {
  clearTimers();
  $$('.modalbg').forEach(m => m.remove());
  const h = location.hash || '#/';
  const r = routes.find(([re]) => re.test(h)) || routes[2];
  const params = h.match(r[0])?.slice(1) || [];
  if (r[2]) { root.innerHTML = ''; return r[1](); }
  if (!me) { try { me = await api('/api/me'); } catch { return; } }
  const el = shell();
  try { await r[1](el, ...params); } catch (e) { el.innerHTML = `<div class="alert err">${esc(e.message)}</div>`; }
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', router);

// ---------------------------------------------------------------- login
function authHero() {
  return `<div class="hero">
    <div class="brand big" style="padding:0 0 34px"><img class="sym" src="/brand/simbolo-branco.png" alt=""><div><img class="word" src="/brand/domma-branco.png" alt="Domma"><div class="prod">CONNECT LEAD</div></div></div>
    <h1>Suba sua planilha.<br>A gente dispara no WhatsApp.</h1>
    <p style="opacity:.85;font-size:17px">Do Excel ao WhatsApp em 4 passos, sem complicação.</p>
    <ul><li>📋 Lê Excel e CSV e arruma os telefones sozinho</li><li>✍️ Mensagens personalizadas com o nome de cada cliente</li>
    <li>🔌 API Oficial da Meta ou QR Code — você escolhe</li><li>🛡️ Envio seguro com pausas automáticas e descadastro</li><li>📊 Relatório de entregues, lidos e respostas</li></ul></div>`;
}
function pageLogin() {
  root.innerHTML = `<div class="auth">${authHero()}<div class="form"><form class="card stack" id="f">
    <h2>Entrar</h2>
    <label class="f">E-mail ou usuário<input name="email" type="text" required autocomplete="username" autocapitalize="none"></label>
    <label class="f">Senha<input name="password" type="password" required autocomplete="current-password"></label>
    <button class="btn primary big">Entrar</button>
    <p class="small muted" style="text-align:center">Ainda não tem conta? <a href="#/cadastro">Criar conta grátis</a></p></form></div></div>`;
  $('#f').onsubmit = safe(async e => {
    e.preventDefault();
    await api('/api/auth/login', { body: Object.fromEntries(new FormData(e.target)) });
    me = null; location.hash = '#/';
  });
}
function pageRegister() {
  root.innerHTML = `<div class="auth">${authHero()}<div class="form"><form class="card stack" id="f">
    <h2>Criar conta</h2>
    <label class="f">Seu nome<input name="name" required></label>
    <label class="f">Empresa<input name="company" placeholder="Ex.: Master Laudo"></label>
    <label class="f">E-mail<input name="email" type="email" required></label>
    <label class="f">Senha<input name="password" type="password" minlength="6" required></label>
    <button class="btn primary big">Criar conta</button>
    <p class="small muted" style="text-align:center">Já tem conta? <a href="#/login">Entrar</a></p></form></div></div>`;
  $('#f').onsubmit = safe(async e => {
    e.preventDefault();
    await api('/api/auth/register', { body: Object.fromEntries(new FormData(e.target)) });
    me = null; location.hash = '#/';
  });
}

// ---------------------------------------------------------------- início
async function pageHome(el) {
  el.innerHTML = `<div class="top"><div><h1>Olá, ${esc(me.user.name.split(' ')[0])} 👋</h1><p class="muted">Resumo dos últimos 30 dias</p></div>
    <a class="btn primary big" href="#/nova">＋ Nova campanha</a></div><div id="dash"><div class="spin"></div></div>`;
  every(async () => {
    const d = await api('/api/dashboard');
    const m = d.metrics;
    const hasConn = d.connections.some(c => c.status === 'conectado'), hasList = d.lists > 0, hasCamp = m.enviados > 0 || d.active.length > 0;
    const maxDay = Math.max(1, ...d.daily.map(x => x.n));
    $('#dash').innerHTML = `
      ${!(hasConn && hasList && hasCamp) ? `<div class="card" style="margin-bottom:18px"><h2>Comece em 3 passos</h2>
        <div class="check ${hasConn ? 'ok' : ''}"><div class="dot">${hasConn ? '✓' : '1'}</div><div class="grow"><b>Conecte seu WhatsApp</b><div class="small muted">Pela API Oficial da Meta ou lendo um QR Code</div></div>${hasConn ? '' : '<a class="btn sm" href="#/conexoes">Conectar</a>'}</div>
        <div class="check ${hasList ? 'ok' : ''}"><div class="dot">${hasList ? '✓' : '2'}</div><div class="grow"><b>Suba sua planilha de clientes</b><div class="small muted">Excel ou CSV — a gente encontra a coluna do telefone sozinho</div></div>${hasList ? '' : '<a class="btn sm" href="#/nova">Subir planilha</a>'}</div>
        <div class="check ${hasCamp ? 'ok' : ''}"><div class="dot">${hasCamp ? '✓' : '3'}</div><div class="grow"><b>Faça seu primeiro disparo</b><div class="small muted">Escreva a mensagem, veja a prévia e dispare</div></div>${hasCamp ? '' : '<a class="btn sm primary" href="#/nova">Criar campanha</a>'}</div></div>` : ''}
      <div class="grid g4">
        ${[['📤', 'Enviadas', m.enviados], ['📬', 'Entregues', m.entregues, pct(m.entregues, m.enviados)], ['👀', 'Lidas', m.lidos, pct(m.lidos, m.enviados)], ['💬', 'Responderam', m.respostas, pct(m.respostas, m.enviados)]]
          .map(([ic, l, v, p]) => `<div class="card metric"><div class="ic">${ic}</div><div class="v">${fmtN(v)}</div><div class="l">${l}${p !== undefined ? ` · ${p}%` : ''}</div></div>`).join('')}
      </div>
      <div class="grid g2" style="margin-top:16px">
        <div class="card"><div class="row between"><h2>Campanhas em andamento</h2><a class="small" href="#/campanhas">Ver todas</a></div>
          ${d.active.length ? d.active.map(c => `<a href="#/campanhas/${c.id}" class="row" style="gap:14px;color:inherit;padding:10px 0;border-bottom:1px solid #f0eef6;flex-wrap:nowrap">
            ${ring('d' + c.id, pct(c.stats.processado, c.stats.total), c.status, 64)}
            <div class="stack grow" style="gap:6px;min-width:0"><div class="row between"><b>${esc(c.name)}</b>${badge(CAMP_STATUS, c.status)}</div>${progressBar(c.stats)}
            <div class="tiny muted">${fmtN(c.stats.processado)} de ${fmtN(c.stats.total)} processados${c.pause_reason ? ' · ' + esc(c.pause_reason) : ''}</div></div></a>`).join('')
            : '<div class="empty" style="padding:24px"><div class="big">📭</div>Nenhuma campanha rodando agora</div>'}
        </div>
        <div class="card"><h2>Envios por dia</h2>
          ${d.daily.length ? `<div class="chart" style="margin-bottom:24px">${d.daily.map(x => `<div style="height:${x.n / maxDay * 100}%" title="${fmtN(x.n)} envios"><span>${x.dia.slice(8, 10)}/${x.dia.slice(5, 7)}</span></div>`).join('')}</div>` : '<p class="muted">Os envios dos últimos 14 dias aparecem aqui.</p>'}
          <h3 style="margin-top:8px">Conexões</h3>
          ${d.connections.length ? d.connections.map(c => `<div class="row between" style="padding:6px 0"><span>${CONN_TYPE[c.type][0]} ${esc(c.name)} <span class="muted small">${esc(c.phone_fmt || '')}</span></span>${badge(CONN_STATUS, c.status)}</div>`).join('') : '<p class="muted small">Nenhuma conexão ainda. <a href="#/conexoes">Conectar WhatsApp</a></p>'}
          <p class="small muted" style="margin-top:10px">🚫 ${fmtN(m.optouts)} pessoa(s) pediram para não receber mais.</p>
        </div>
      </div>`;
  }, 4000);
}

// ---------------------------------------------------------------- wizard
let W = null;
function newWizard() {
  const d = new Date();
  W = { step: 1, list: null, conn: null, mode: 'texto', message: '', media: null, add_optout_footer: true,
    template: null, tplParams: { body: [], header: null }, speed: 'segura', custom_min: 20, custom_max: 45, custom_every: 20, custom_pause: 3,
    ai_enabled: false, ai_instructions: '', aiPreview: null, business_hours: true, when: 'agora', scheduled_at: '',
    name: `Campanha ${d.toLocaleDateString('pt-BR')} ${d.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`, previewIdx: 0 };
}
async function pageWizard(el) {
  if (!W || W.done) newWizard();
  const [conns, lists, settings] = await Promise.all([api('/api/connections'), api('/api/lists'), api('/api/settings')]);
  W.conns = conns; W.lists = lists; W.settings = settings;
  if (!W.defaultsApplied) {
    const d = settings.disparo; W.defaultsApplied = true;
    Object.assign(W, { speed: d.velocidade_padrao || 'segura', custom_min: d.custom_min, custom_max: d.custom_max, custom_every: d.custom_every, custom_pause: d.custom_pause, business_hours: d.horario_padrao_ligado !== false });
  }
  if (!W.conn) W.conn = conns.find(c => c.status === 'conectado') || conns[0] || null;
  else W.conn = conns.find(c => c.id === W.conn.id) || null;
  renderWizard(el);
}
function renderWizard(el) {
  const names = ['Contatos', 'Mensagem', 'Envio', 'Revisar'];
  el.innerHTML = `<div class="top"><div><h1>Nova campanha</h1><p class="muted">Da planilha ao WhatsApp em 4 passos</p></div>
    <button class="btn ghost" id="restart">Recomeçar</button></div>
    <div class="steps">${names.map((n, i) => `<div class="step ${W.step === i + 1 ? 'on' : W.step > i + 1 ? 'done click' : ''}" data-go="${i + 1}"><b>${W.step > i + 1 ? '✓' : i + 1}</b>${n}</div>`).join('')}</div>
    <div id="wbody"></div>`;
  $('#restart').onclick = () => { newWizard(); pageWizard(el); };
  $$('.step.done', el).forEach(s => s.onclick = () => { W.step = Number(s.dataset.go); renderWizard(el); });
  const body = $('#wbody', el);
  ({ 1: wStep1, 2: wStep2, 3: wStep3, 4: wStep4 })[W.step](body, el);
}
const wizFoot = (back, next, nextLabel = 'Continuar →', disabled) => `<div class="wizfoot">${back ? '<button class="btn" id="back">← Voltar</button>' : '<span></span>'}
  ${next ? `<button class="btn primary big" id="next" ${disabled ? 'disabled' : ''}>${nextLabel}</button>` : ''}</div>`;

// --- passo 1: contatos
function wStep1(body, el) {
  const L = W.list;
  body.innerHTML = `<div class="card">
    ${!L ? `
      <h2>Suba a planilha com seus contatos</h2>
      <p class="muted">Aceita Excel (.xlsx, .xls) e .csv. Basta ter uma coluna com o telefone — nome e outras colunas viram variáveis na mensagem.</p>
      <label class="drop" id="drop"><input type="file" id="file" accept=".xlsx,.xls,.csv,.txt" hidden>
        <div class="big">📄</div><b style="font-size:17px">Arraste a planilha aqui ou clique para escolher</b>
        <div class="small muted" style="margin-top:6px">Os telefones podem estar em qualquer formato: (31) 99999-9999, 31999999999, +55…</div></label>
      <div class="row" style="margin-top:12px"><span class="small muted">Números sem DDD? Usar o DDD</span><input id="ddd" style="width:80px" maxlength="2" placeholder="31" inputmode="numeric"></div>
      ${W.lists.length ? `<div style="margin-top:22px"><h3>…ou use uma lista que você já subiu</h3>
        <div class="tablewrap"><table class="table"><tr><th>Lista</th><th>Válidos</th><th>Enviada em</th><th></th></tr>
        ${W.lists.slice(0, 6).map(l => `<tr><td><b>${esc(l.name)}</b></td><td>${fmtN(l.valid)} de ${fmtN(l.total)}</td><td class="muted small">${fmtDate(l.created_at)}</td><td style="text-align:right"><button class="btn sm" data-use="${l.id}">Usar esta</button></td></tr>`).join('')}
        </table></div></div>` : ''}
      <div id="upmsg"></div>`
    : `
      <div class="row between"><div><h2 style="margin:0">📋 ${esc(L.name)}</h2><p class="muted small">${fmtN(L.total)} linhas lidas</p></div><button class="btn sm" id="change">Trocar planilha</button></div>
      <div class="grid g4" style="margin:14px 0">
        <div class="stat"><span style="font-size:22px">✅</span><div><div class="n">${fmtN(L.valid - (L.optouts || 0))}</div><div class="small muted">vão receber</div></div></div>
        <div class="stat"><span style="font-size:22px">⚠️</span><div><div class="n">${fmtN(L.invalid)}</div><div class="small muted">telefones inválidos</div></div></div>
        <div class="stat"><span style="font-size:22px">♻️</span><div><div class="n">${fmtN(L.duplicates)}</div><div class="small muted">repetidos (removidos)</div></div></div>
        <div class="stat"><span style="font-size:22px">🚫</span><div><div class="n">${fmtN(L.optouts || 0)}</div><div class="small muted">descadastrados</div></div></div>
      </div>
      <div class="grid g3">
        <label class="f">Coluna do WhatsApp<select id="pcol">${L.columns.map(c => `<option value="${c.key}" ${c.key === L.phone_column ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
        <label class="f">Coluna do nome<select id="ncol"><option value="">(sem nome)</option>${L.columns.map(c => `<option value="${c.key}" ${c.key === L.name_column ? 'selected' : ''}>${esc(c.label)}</option>`).join('')}</select></label>
        <label class="f">DDD para números sem DDD<input id="ddd2" maxlength="2" placeholder="Ex.: 31" inputmode="numeric"></label>
      </div>
      ${L.invalid ? `<div class="alert warn" style="margin-top:12px">⚠️ <div>${fmtN(L.invalid)} linha(s) com telefone inválido não serão enviadas. <a href="/api/lists/${L.id}/export?status=invalido">Baixar as linhas com problema</a> para corrigir.</div></div>` : ''}
      <h3 style="margin-top:18px">Prévia</h3>
      <div class="tablewrap"><table class="table"><tr><th>Linha</th><th>Situação</th><th>WhatsApp</th><th>Nome</th>${L.columns.filter(c => c.key !== L.phone_column && c.key !== L.name_column).slice(0, 3).map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>
      ${L.preview.map(c => `<tr><td class="muted">${c.row_number}</td><td>${c.status === 'valido' ? '<span class="badge ok">OK</span>' : `<span class="badge ${c.status === 'duplicado' ? 'plain' : 'warn'}" title="${esc(c.error)}">${esc(c.error)}</span>`}</td><td>${esc(c.phone_fmt)}</td><td>${esc(c.name)}</td>
        ${L.columns.filter(x => x.key !== L.phone_column && x.key !== L.name_column).slice(0, 3).map(x => `<td>${esc(c.data[x.key])}</td>`).join('')}</tr>`).join('')}
      </table></div>`}
    ${wizFoot(false, !!L, 'Continuar para a mensagem →', !L || L.valid === 0)}
  </div>`;
  if (!L) {
    const drop = $('#drop'), file = $('#file');
    const send = safe(async f => {
      $('#upmsg').innerHTML = '<div class="row" style="margin-top:16px"><div class="spin"></div><span>Lendo a planilha e arrumando os telefones…</span></div>';
      const ddd = $('#ddd').value.replace(/\D/g, '');
      try {
        const up = await uploadFile(f, { temp: true });
        W.list = await api('/api/lists/import', { body: { file: up.file, defaultDDD: ddd || null } });
      } finally { $('#upmsg') && ($('#upmsg').innerHTML = ''); }
      renderWizard(el);
    });
    file.onchange = () => file.files[0] && send(file.files[0]);
    drop.ondragover = e => { e.preventDefault(); drop.classList.add('over'); };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = e => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && send(e.dataTransfer.files[0]); };
    $$('[data-use]').forEach(b => b.onclick = safe(async () => { W.list = await api('/api/lists/' + b.dataset.use); renderWizard(el); }));
    return;
  }
  $('#change').onclick = () => { W.list = null; renderWizard(el); };
  const remap = safe(async () => {
    W.list = await api(`/api/lists/${L.id}/remap`, { body: { phoneColumn: $('#pcol').value, nameColumn: $('#ncol').value, defaultDDD: $('#ddd2').value.replace(/\D/g, '') } });
    renderWizard(el);
  });
  $('#pcol').onchange = remap; $('#ncol').onchange = remap; $('#ddd2').onchange = remap;
  $('#next').onclick = () => { W.step = 2; renderWizard(el); };
}

// --- passo 2: mensagem
function varChips() {
  const base = [['primeiro_nome', 'Primeiro nome'], ['nome', 'Nome completo'], ['saudacao', 'Bom dia/Boa tarde']];
  const cols = (W.list?.columns || []).filter(c => c.key !== W.list.phone_column && c.key !== W.list.name_column).map(c => [c.key, c.label]);
  return [...base, ...cols];
}
function wStep2(body, el) {
  const conns = W.conns;
  if (!conns.length) {
    body.innerHTML = `<div class="card"><div class="empty"><div class="big">🔌</div><h2>Conecte um WhatsApp primeiro</h2>
      <p>Para disparar, você precisa de pelo menos uma conexão. Quer só testar? Crie uma conexão de teste — nada é enviado de verdade.</p>
      <div class="row" style="justify-content:center;margin-top:14px"><a class="btn primary" href="#/conexoes">Conectar WhatsApp</a><button class="btn" id="mkTest">🧪 Criar conexão de teste</button></div></div>${wizFoot(true)}</div>`;
    $('#mkTest').onclick = safe(async () => { await api('/api/connections', { body: { type: 'simulado' } }); await pageWizard(el); });
    $('#back').onclick = () => { W.step = 1; renderWizard(el); };
    return;
  }
  const isOfc = W.conn?.type === 'oficial';
  if (!isOfc) W.mode = 'texto';
  body.innerHTML = `<div class="grid" style="grid-template-columns:minmax(0,1fr) 320px;align-items:start">
    <div class="card stack">
      <div><h2>Enviar por</h2><div class="grid g3">${conns.map(c => `<label class="opt ${W.conn?.id === c.id ? 'on' : ''}" data-conn="${c.id}">
        <div class="t">${CONN_TYPE[c.type][0]} ${esc(c.name)}</div><div class="small muted">${CONN_TYPE[c.type][1]} ${esc(c.phone_fmt || '')}</div><div style="margin-top:6px">${badge(CONN_STATUS, c.status)}</div></label>`).join('')}</div>
        ${W.conn && W.conn.status !== 'conectado' ? `<div class="alert warn" style="margin-top:10px">⚠️ Esta conexão não está conectada. <a href="#/conexoes">Conectar agora</a> — a campanha só envia com ela conectada.</div>` : ''}
      </div>
      ${isOfc ? `<div class="tabs"><button class="tab ${W.mode === 'template' ? 'on' : ''}" data-mode="template">Modelo aprovado (recomendado)</button><button class="tab ${W.mode === 'texto' ? 'on' : ''}" data-mode="texto">Texto livre</button></div>` : ''}
      <div id="msgArea"></div>
    </div>
    <div><div class="phone"><div class="scr"><div class="hd"><div class="av" id="pvAv">M</div><div><div id="pvName">Cliente</div><div class="tiny" style="opacity:.8" id="pvPhone"></div></div></div>
      <div class="body"><div class="bubble" id="pvMsg"></div></div></div></div>
      <div class="row" style="justify-content:center;margin-top:10px"><button class="btn sm" id="pvNext">Ver outro contato ↻</button></div>
      <div id="pvWarn" style="margin-top:10px"></div></div>
  </div>
  <div class="card" style="margin-top:16px;padding:14px 20px">${wizFoot(true, true).replace('class="wizfoot"', 'class="wizfoot" style="margin:0;padding:0;border:0"')}</div>`;
  $$('[data-conn]').forEach(o => o.onclick = () => { W.conn = conns.find(c => c.id == o.dataset.conn); W.template = null; renderWizard(el); });
  $$('[data-mode]').forEach(t => t.onclick = () => { W.mode = t.dataset.mode; renderWizard(el); });
  $('#back').onclick = () => { W.step = 1; renderWizard(el); };
  $('#pvNext').onclick = () => { W.previewIdx = (W.previewIdx + 1) % 3; updatePreview(); };
  $('#next').onclick = () => {
    if (!W.conn) return toast('Escolha por qual WhatsApp enviar', true);
    if (W.mode === 'texto' && !W.message.trim() && !W.media && !(W.ai_enabled && W.ai_instructions.trim())) return toast('Escreva a mensagem', true);
    if (W.mode === 'texto' && W.ai_enabled && !W.settings.ai_has_key) return toast('Configure uma IA no Administrador ou desligue a personalização', true);
    if (W.mode === 'template' && !W.template) return toast('Escolha um modelo aprovado', true);
    if (W.mode === 'template' && W.tplParams.body.some(v => !String(v || '').trim())) return toast('Preencha todas as variáveis do modelo', true);
    if (W.mode === 'template' && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(W.template.header?.format) && !W.media) return toast('Este modelo exige um arquivo no cabeçalho', true);
    W.step = 3; renderWizard(el);
  };
  if (W.mode === 'template') renderTemplateArea(); else renderTextArea();
}

function renderTextArea() {
  const a = $('#msgArea');
  a.innerHTML = `
    <div class="row between"><h2 style="margin:0">Mensagem</h2><button class="btn sm" id="tplBtn">✨ Usar um modelo pronto</button></div>
    <div><div class="small muted" style="margin-bottom:6px">Clique para inserir no texto — cada contato recebe com os próprios dados:</div>
      <div class="chips">${varChips().map(([k, l]) => `<button class="chip" data-var="${k}">${esc(l)}</button>`).join('')}</div></div>
    <textarea id="msg" placeholder="Ex.: {{saudacao}}, {{primeiro_nome}}! Tudo bem?">${esc(W.message)}</textarea>
    <div class="row between">
      <div class="row" style="gap:6px"><button class="btn sm" data-wrap="*" title="Negrito"><b>N</b></button><button class="btn sm" data-wrap="_" title="Itálico"><i>I</i></button><button class="btn sm" data-wrap="~" title="Riscado"><s>R</s></button>
        <button class="btn sm" id="spinBtn" title="Cada contato recebe uma das opções — deixa o envio mais natural">🔀 Variar palavras</button></div>
      <span class="tiny muted" id="cnt"></span></div>
    <div class="row between" style="padding:12px;border:1px solid var(--borda);border-radius:12px">
      <div id="mediaBox">${W.media ? `📎 <b>${esc(W.media.name)}</b> <button class="btn sm ghost" id="rmMedia">remover</button>` : '<span class="muted">Sem anexo</span>'}</div>
      <div class="row" style="gap:6px">${W.settings.gallery?.length ? '<button class="btn sm" id="galBtn">🖼️ Da galeria</button>' : ''}<label class="btn sm">📎 Anexar imagem, vídeo, PDF ou áudio<input type="file" id="mediaFile" hidden accept="image/*,video/*,audio/*,application/pdf,.doc,.docx,.xls,.xlsx"></label></div></div>
    ${W.conn?.type !== 'oficial' ? `<label class="switch"><input type="checkbox" id="optf" ${W.add_optout_footer ? 'checked' : ''}><i></i> Incluir no final: “responda SAIR para não receber mais” <span class="tiny muted">(recomendado — protege seu número)</span></label>` : `<div class="alert warn">⚠️ Na API Oficial, texto livre só chega para quem falou com você nas últimas 24h. Para listas frias, use um <b>modelo aprovado</b>.</div>`}
    <div style="border:1px solid #d9cffb;background:var(--roxo-bg);border-radius:14px;padding:14px" class="stack">
      <label class="switch"><input type="checkbox" id="aiOn" ${W.ai_enabled ? 'checked' : ''}><i></i> <b>✨ IA personaliza cada mensagem</b></label>
      <div class="small muted" style="margin-top:-6px">A IA reescreve a mensagem para cada contato usando os dados da planilha e o que você contou sobre o seu negócio. Cada cliente recebe um texto único.</div>
      ${W.ai_enabled ? `
        ${!W.settings.ai_has_key ? '<div class="alert warn small">⚠️ Falta configurar a IA. <a href="#/admin/ia">Abrir o Administrador</a> e informar a chave do Claude, ChatGPT ou Gemini.</div>' : ''}
        ${!W.settings.business_profile ? '<div class="alert warn small">💡 Preencha o <a href="#/admin/playbook">perfil e o playbook de vendas</a> — a IA escreve muito melhor sabendo o que você vende.</div>' : ''}
        <label class="f">O que a IA deve fazer?<span class="h">Objetivo e tom. A mensagem acima serve de base (pode deixar em branco se preferir só a instrução).</span>
          <textarea id="aiIns" style="min-height:90px" placeholder="Ex.: Ofereça a vistoria de transferência com laudo na hora. Tom amigável e direto. Cite a cidade do cliente.">${esc(W.ai_instructions)}</textarea></label>
        <div class="row"><button class="btn sm primary" id="aiGen">✨ Gerar prévia com IA</button><span class="tiny muted" id="aiSt">${W.aiPreview ? 'Prévia gerada — veja no celular ao lado' : 'Gera exemplos com os 3 primeiros contatos'}</span></div>` : ''}
    </div>
    <details class="small muted"><summary style="cursor:pointer">Dicas de formatação</summary><p style="margin-top:8px"><kbd>{{primeiro_nome}}</kbd> insere o nome · <kbd>{{cidade|sua cidade}}</kbd> usa “sua cidade” se a coluna estiver vazia · <kbd>{Oi|Olá|E aí}</kbd> sorteia uma opção por contato · <kbd>*negrito*</kbd> <kbd>_itálico_</kbd> <kbd>~riscado~</kbd></p></details>`;
  const ta = $('#msg');
  const insert = (txt, wrap) => {
    const s = ta.selectionStart, e = ta.selectionEnd, v = ta.value;
    const mid = wrap ? wrap + (v.slice(s, e) || 'texto') + wrap : txt;
    ta.value = v.slice(0, s) + mid + v.slice(e);
    ta.focus(); ta.selectionStart = ta.selectionEnd = s + mid.length;
    ta.dispatchEvent(new Event('input'));
  };
  $$('[data-var]').forEach(b => b.onclick = () => insert(`{{${b.dataset.var}}}`));
  $$('[data-wrap]').forEach(b => b.onclick = () => insert('', b.dataset.wrap));
  $('#spinBtn').onclick = () => insert('{Oi|Olá|E aí}');
  let t;
  ta.oninput = () => { W.message = ta.value; W.aiPreview = null; $('#cnt').textContent = `${ta.value.length} caracteres`; clearTimeout(t); t = setTimeout(updatePreview, 250); };
  $('#cnt').textContent = `${ta.value.length} caracteres`;
  $('#optf') && ($('#optf').onchange = e => { W.add_optout_footer = e.target.checked; updatePreview(); });
  $('#tplBtn').onclick = safe(openModelos);
  $('#aiOn').onchange = e => { W.ai_enabled = e.target.checked; W.aiPreview = null; renderTextArea(); };
  $('#aiIns') && ($('#aiIns').oninput = e => { W.ai_instructions = e.target.value; });
  $('#aiGen') && ($('#aiGen').onclick = safe(async () => {
    const b = $('#aiGen'); b.disabled = true; $('#aiSt').textContent = 'A IA está escrevendo…';
    try {
      const r = await api('/api/ai/preview', { body: { message: W.message, instructions: W.ai_instructions, list_id: W.list?.id } });
      W.aiPreview = r.previews; W.previewIdx = 0;
      $('#aiSt').textContent = 'Prévia gerada — use “Ver outro contato” para comparar';
      updatePreview();
    } catch (e) { $('#aiSt').textContent = ''; throw e; } finally { b.disabled = false; }
  }));
  $('#mediaFile').onchange = safe(async e => {
    const f = e.target.files[0]; if (!f) return;
    $('#mediaBox').innerHTML = '<span class="muted">Enviando…</span>';
    const m = await uploadFile(f);
    W.media = { ...m, localUrl: URL.createObjectURL(f) };
    renderTextArea(); updatePreview();
  });
  $('#galBtn') && ($('#galBtn').onclick = () => {
    const g = W.settings.gallery;
    const m = modal(`<div class="row between"><h2 style="margin:0">Galeria da empresa</h2><button class="btn ghost sm" data-close>✕</button></div>
      <div class="grid g3" style="margin-top:12px">${g.map((x, i) => `<div class="opt" data-g="${i}" style="padding:10px">${x.mime.startsWith('image/') ? `<img src="/media/${esc(x.file)}" style="width:100%;height:110px;object-fit:cover;border-radius:9px">` : '<div style="height:110px;display:grid;place-items:center;font-size:40px">📄</div>'}<div class="small" style="margin-top:6px;font-weight:600">${esc(x.titulo)}</div></div>`).join('')}</div>`, { wide: true });
    $$('[data-g]', m).forEach(o => o.onclick = () => { const x = g[o.dataset.g]; W.media = { file: x.file, mime: x.mime, name: x.name, localUrl: '/media/' + x.file }; m.close(); renderTextArea(); updatePreview(); });
  });
  $('#rmMedia') && ($('#rmMedia').onclick = () => { W.media = null; renderTextArea(); updatePreview(); });
  updatePreview();
}

async function openModelos() {
  const list = await api('/api/modelos');
  const cats = [...new Set(list.map(m => m.categoria))];
  const m = modal(`<div class="row between"><h2 style="margin:0">Modelos prontos</h2><button class="btn ghost sm" data-close>✕</button></div>
    <p class="muted small">Escolha um ponto de partida e ajuste do seu jeito.</p>
    ${cats.map(c => `<h3 style="margin-top:14px">${c === 'Automotivo' ? '🚗' : '💼'} ${c}</h3><div class="grid g2">${list.filter(x => x.categoria === c).map(x => `
      <div class="opt" data-m="${x.id}"><div class="t">${esc(x.titulo)}</div><div class="small muted" style="white-space:pre-wrap;max-height:84px;overflow:hidden">${esc(x.texto)}</div></div>`).join('')}</div>`).join('')}`, { wide: true });
  $$('[data-m]', m).forEach(o => o.onclick = () => {
    const x = list.find(i => i.id === o.dataset.m);
    W.message = x.texto; if (W.name.startsWith('Campanha ')) W.name = x.titulo + ' — ' + new Date().toLocaleDateString('pt-BR');
    m.close(); renderTextArea();
  });
}

async function renderTemplateArea() {
  const a = $('#msgArea');
  a.innerHTML = '<div class="row"><div class="spin"></div> Buscando seus modelos aprovados na Meta…</div>';
  let tpls;
  try { tpls = W.tplCache?.[W.conn.id] || await api(`/api/connections/${W.conn.id}/templates`); }
  catch (e) { a.innerHTML = `<div class="alert err">Não consegui listar os modelos: ${esc(e.message)}</div>`; return updatePreview(); }
  W.tplCache = { ...(W.tplCache || {}), [W.conn.id]: tpls };
  if (!tpls.length) { a.innerHTML = '<div class="alert warn">Você ainda não tem modelos aprovados. Crie um no Gerenciador do WhatsApp da Meta e volte aqui.</div>'; return updatePreview(); }
  const opts = varChips();
  const paramSelect = (val, i, kind) => {
    const isVar = /^\{\{[a-z0-9_]+\}\}$/.test(val || '');
    return `<div class="row" style="gap:8px"><span class="badge plain" style="min-width:54px;justify-content:center">{{${i + 1}}}</span>
      <select data-${kind}sel="${i}" style="max-width:220px"><option value="">Texto fixo…</option>${opts.map(([k, l]) => `<option value="{{${k}}}" ${val === `{{${k}}}` ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>
      <input data-${kind}txt="${i}" class="grow" style="width:auto" placeholder="Digite o texto" value="${isVar ? '' : esc(val || '')}" ${isVar ? 'hidden' : ''}></div>`;
  };
  const t = W.template;
  a.innerHTML = `<label class="f">Modelo aprovado pela Meta<select id="tplSel"><option value="">Escolha…</option>${tpls.map((x, i) => `<option value="${i}" ${t && t.name === x.name && t.language === x.language ? 'selected' : ''}>${esc(x.name)} (${esc(x.language)}) · ${esc(x.category)}</option>`).join('')}</select></label>
    ${t ? `<div class="alert info small" style="white-space:pre-wrap">${esc(t.body)}</div>
      ${t.header_params ? `<div><b>Variável do cabeçalho</b>${paramSelect(W.tplParams.header?.value, 0, 'h')}</div>` : ''}
      ${['IMAGE', 'VIDEO', 'DOCUMENT'].includes(t.header?.format) ? `<div class="row between" style="padding:12px;border:1px solid var(--borda);border-radius:12px"><div>${W.media ? `📎 <b>${esc(W.media.name)}</b>` : `<span class="muted">Este modelo pede ${({ IMAGE: 'uma imagem', VIDEO: 'um vídeo', DOCUMENT: 'um documento' })[t.header.format]} no topo</span>`}</div><label class="btn sm">📎 Escolher arquivo<input type="file" id="hdrFile" hidden></label></div>` : ''}
      ${t.body_params ? `<div class="stack" style="gap:8px"><b>Preencha as variáveis do modelo</b>${Array.from({ length: t.body_params }, (_, i) => paramSelect(W.tplParams.body[i], i, 'b')).join('')}</div>` : ''}` : ''}`;
  $('#tplSel').onchange = e => {
    const x = tpls[e.target.value];
    W.template = x || null;
    W.tplParams = { body: Array.from({ length: x?.body_params || 0 }, (_, i) => i === 0 ? '{{primeiro_nome}}' : ''), header: x?.header_params ? { type: 'text', value: '' } : (x && ['IMAGE', 'VIDEO', 'DOCUMENT'].includes(x.header?.format) ? { type: x.header.format.toLowerCase() } : null) };
    W.media = null; renderTemplateArea();
  };
  const bind = (kind, setter) => {
    $$(`[data-${kind}sel]`).forEach(s => s.onchange = () => { const i = s.dataset[kind + 'sel']; const inp = $(`[data-${kind}txt="${i}"]`); inp.hidden = !!s.value; setter(i, s.value || inp.value); updatePreview(); });
    $$(`[data-${kind}txt]`).forEach(inp => inp.oninput = () => { setter(inp.dataset[kind + 'txt'], inp.value); updatePreview(); });
  };
  bind('b', (i, v) => { W.tplParams.body[i] = v; });
  bind('h', (i, v) => { W.tplParams.header = { type: 'text', value: v }; });
  $('#hdrFile') && ($('#hdrFile').onchange = safe(async e => {
    const f = e.target.files[0]; if (!f) return;
    W.media = { ...(await uploadFile(f)), localUrl: URL.createObjectURL(f) };
    renderTemplateArea();
  }));
  updatePreview();
}

let pvSeq = 0;
async function updatePreview() {
  const msgEl = $('#pvMsg'); if (!msgEl) return;
  let text = '';
  if (W.mode === 'template') {
    if (!W.template) text = 'Escolha um modelo para ver a prévia';
    else text = W.template.body.replace(/\{\{(\d+)\}\}/g, (_, n) => W.tplParams.body[n - 1] || `{{${n}}}`) + (W.template.footer ? `\n\n_${W.template.footer}_` : '');
  } else text = W.message || (W.media ? '' : 'Sua mensagem aparece aqui…');
  const seq = ++pvSeq;
  const r = await api('/api/preview', { body: { message: text, list_id: W.list?.id, add_optout_footer: W.mode === 'texto' && W.conn?.type !== 'oficial' && W.add_optout_footer && !!W.message } }).catch(() => null);
  if (!r || seq !== pvSeq || !$('#pvMsg')) return;
  let p = r.previews[W.previewIdx % r.previews.length];
  if (W.mode === 'texto' && W.ai_enabled && W.aiPreview?.length) {
    const a = W.aiPreview[W.previewIdx % W.aiPreview.length];
    p = { ...p, nome: a.nome, telefone: a.telefone, texto: a.erro ? `⚠️ ${a.erro}` : a.texto + (W.add_optout_footer && W.conn?.type !== 'oficial' && W.settings?.optout_footer ? `\n\n_${W.settings.optout_footer}_` : '') };
  }
  $('#pvName').textContent = p.nome || 'Cliente';
  $('#pvAv').textContent = (p.nome || 'C')[0].toUpperCase();
  $('#pvPhone').textContent = p.telefone;
  const mediaHtml = W.media ? (W.media.mime?.startsWith('image/') ? `<img src="${W.media.localUrl}">` : `<div class="doc">📎 ${esc(W.media.name)}</div>`) : '';
  $('#pvMsg').innerHTML = mediaHtml + waFormat(p.texto) + `<span class="tm">${new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} ✓✓</span>`;
  $('#pvWarn').innerHTML = r.unknown_vars.length ? `<div class="alert warn small">⚠️ Não encontrei na planilha: ${r.unknown_vars.map(v => `<kbd>{{${esc(v)}}}</kbd>`).join(' ')} — vai sair em branco.</div>` : '';
}

// --- passo 3: envio
async function wStep3(body, el) {
  const count = (W.list.valid || 0) - (W.list.optouts || 0);
  const type = W.conn.type;
  const est = await api('/api/estimate', { body: { connection_id: W.conn.id, speed: W.speed, count } });
  const speeds = est.speeds;
  const custom = { custom_min: W.custom_min, custom_max: W.custom_max, custom_every: W.custom_every, custom_pause: W.custom_pause };
  const ests = await Promise.all(['segura', 'normal', 'rapida', 'personalizado'].map(s => api('/api/estimate', { body: { connection_id: W.conn.id, speed: s, count, custom } })));
  const desc = type === 'oficial'
    ? { segura: 'Ritmo tranquilo', normal: 'Bom equilíbrio', rapida: 'O mais rápido que a Meta permite' }
    : { segura: 'Intervalos longos e pausas — menor risco de bloqueio', normal: 'Para números já “aquecidos”', rapida: 'Só para listas que já conhecem você' };
  body.innerHTML = `<div class="card stack">
    <label class="f">Nome da campanha<span class="h">Só para você se organizar</span><input id="cname" value="${esc(W.name)}"></label>
    <div><h2>Quando enviar?</h2><div class="grid g2">
      <label class="opt ${W.when === 'agora' ? 'on' : ''}" data-when="agora"><div class="t">⚡ Agora</div><div class="small muted">Começa assim que você confirmar</div></label>
      <label class="opt ${W.when === 'agendar' ? 'on' : ''}" data-when="agendar"><div class="t">🗓️ Agendar</div><div class="small muted">Escolha dia e hora</div>
        ${W.when === 'agendar' ? `<input type="datetime-local" id="sched" style="margin-top:8px" value="${esc(W.scheduled_at)}">` : ''}</label></div></div>
    <div><h2>Velocidade</h2><div class="grid g3">${['segura', 'normal', 'rapida'].map((s, i) => `
      <label class="opt ${W.speed === s ? 'on' : ''}" data-speed="${s}"><div class="t">${['🛡️', '🚗', '🚀'][i]} ${speeds[s].label} ${s === 'segura' && type !== 'oficial' ? '<span class="badge roxo plain">recomendada</span>' : ''}</div>
      <div class="small muted">${desc[s]}</div><div class="small" style="margin-top:6px">⏱️ ~${fmtDur(ests[i].seconds)} para ${fmtN(count)} contatos</div></label>`).join('')}</div>
      <label class="opt ${W.speed === 'personalizado' ? 'on' : ''}" data-speed="personalizado" style="margin-top:12px"><div class="t">🎛️ Personalizado — você define o tempo</div>
        <div class="small muted">Escolha o intervalo entre cada mensagem. O sistema sorteia um tempo entre o mínimo e o máximo para parecer natural.</div>
        ${W.speed === 'personalizado' ? `<div class="row" style="margin-top:10px;gap:8px">Entre <input id="cmin" type="number" min="1" style="width:84px" value="${W.custom_min}"> e <input id="cmax" type="number" min="1" style="width:84px" value="${W.custom_max}"> segundos por mensagem</div>
          <div class="row" style="margin-top:8px;gap:8px">Pausa de <input id="cpause" type="number" min="0" style="width:70px" value="${W.custom_pause}"> min a cada <input id="cevery" type="number" min="0" style="width:70px" value="${W.custom_every}"> mensagens <span class="tiny muted">(0 = sem pausa)</span></div>
          <div class="small" style="margin-top:8px">⏱️ ~${fmtDur(ests[3].seconds)} para ${fmtN(count)} contatos</div>` : ''}</label></div>
    <label class="switch"><input type="checkbox" id="bh" ${W.business_hours ? 'checked' : ''}><i></i> Enviar só no horário permitido (${esc(W.settings.hours_label)}) — fora disso a campanha espera sozinha</label>
    ${type === 'qr' ? '<div class="alert info small">🛡️ No QR Code, o sistema simula “digitando…”, varia o intervalo entre mensagens e faz pausas automáticas para proteger seu número.</div>' : ''}
    ${wizFoot(true, true, 'Revisar →')}</div>`;
  $$('[data-when]').forEach(o => o.onclick = e => { if (e.target.id === 'sched') return; W.name = $('#cname').value; W.when = o.dataset.when; renderWizard(el); });
  $$('[data-speed]').forEach(o => o.onclick = () => { W.name = $('#cname').value; W.speed = o.dataset.speed; renderWizard(el); });
  $('#bh').onchange = e => W.business_hours = e.target.checked;
  const readCustom = () => { if (!$('#cmin')) return; W.custom_min = Number($('#cmin').value) || 1; W.custom_max = Number($('#cmax').value) || W.custom_min; W.custom_pause = Number($('#cpause').value) || 0; W.custom_every = Number($('#cevery').value) || 0; };
  $$('#cmin,#cmax,#cpause,#cevery').forEach(i => { i.onclick = e => e.stopPropagation(); i.onchange = () => { readCustom(); W.name = $('#cname').value; renderWizard(el); }; });
  $('#sched') && ($('#sched').onchange = e => W.scheduled_at = e.target.value);
  $('#back').onclick = () => { W.name = $('#cname').value; W.step = 2; renderWizard(el); };
  $('#next').onclick = () => {
    W.name = $('#cname').value.trim();
    if (!W.name) return toast('Dê um nome para a campanha', true);
    readCustom();
    if (W.speed === 'personalizado' && W.custom_max < W.custom_min) return toast('O tempo máximo precisa ser maior ou igual ao mínimo', true);
    if (W.when === 'agendar' && (!W.scheduled_at || new Date(W.scheduled_at) <= new Date())) return toast('Escolha uma data e hora no futuro', true);
    W.est = ests[['segura', 'normal', 'rapida', 'personalizado'].indexOf(W.speed)].seconds;
    W.step = 4; renderWizard(el);
  };
}

// --- passo 4: revisar
function wStep4(body, el) {
  const count = (W.list.valid || 0) - (W.list.optouts || 0);
  const speedL = W.speed === 'personalizado' ? `🎛️ ${W.custom_min}–${W.custom_max}s entre mensagens${W.custom_every && W.custom_pause ? `, pausa de ${W.custom_pause} min a cada ${W.custom_every}` : ''}` : { segura: '🛡️ Segura', normal: '🚗 Normal', rapida: '🚀 Rápida' }[W.speed];
  body.innerHTML = `<div class="grid" style="grid-template-columns:minmax(0,1fr) 320px;align-items:start">
    <div class="card stack">
      <h2>Tudo pronto? Confira antes de disparar</h2>
      <div class="tablewrap"><table class="table">
        <tr><td class="muted" style="width:190px">Campanha</td><td><b>${esc(W.name)}</b></td></tr>
        <tr><td class="muted">Lista</td><td>${esc(W.list.name)} — <b>${fmtN(count)} contatos</b>${W.list.invalid + W.list.duplicates ? ` <span class="muted small">(${fmtN(W.list.invalid + W.list.duplicates)} ignorados)</span>` : ''}</td></tr>
        <tr><td class="muted">Enviar por</td><td>${CONN_TYPE[W.conn.type][0]} ${esc(W.conn.name)} ${badge(CONN_STATUS, W.conn.status)}</td></tr>
        <tr><td class="muted">Mensagem</td><td>${W.mode === 'template' ? `Modelo <b>${esc(W.template.name)}</b>` : W.ai_enabled ? '✨ Personalizada pela IA para cada contato' : 'Texto personalizado'}${W.media ? ` + anexo 📎 ${esc(W.media.name)}` : ''}</td></tr>
        <tr><td class="muted">Quando</td><td>${W.when === 'agora' ? 'Agora' : fmtDate(W.scheduled_at)}${W.business_hours ? ' · só em horário comercial' : ''}</td></tr>
        <tr><td class="muted">Velocidade</td><td>${speedL} · termina em ~${fmtDur(W.est)}</td></tr>
      </table></div>
      ${W.conn.status !== 'conectado' ? '<div class="alert warn">⚠️ A conexão escolhida está desconectada. A campanha será criada e ficará pausada até você conectar.</div>' : ''}
      ${W.conn.type === 'oficial' && W.mode === 'template' ? '<div class="alert info small">💳 Na API Oficial, a Meta cobra cada conversa iniciada diretamente na sua conta do WhatsApp Business.</div>' : ''}
      <label class="switch"><input type="checkbox" id="agree"><i></i> Confirmo que esses contatos são meus clientes ou aceitaram receber mensagens</label>
      <div class="wizfoot"><button class="btn" id="back">← Voltar</button><div class="row"><button class="btn" id="draft">Salvar rascunho</button><button class="btn primary big" id="go">🚀 ${W.when === 'agora' ? `Disparar para ${fmtN(count)} contatos` : 'Agendar campanha'}</button></div></div>
    </div>
    <div><div class="phone"><div class="scr"><div class="hd"><div class="av" id="pvAv">M</div><div><div id="pvName">Cliente</div><div class="tiny" style="opacity:.8" id="pvPhone"></div></div></div><div class="body"><div class="bubble" id="pvMsg"></div></div></div></div>
    <div id="pvWarn" style="margin-top:10px"></div></div></div>`;
  updatePreview();
  $('#back').onclick = () => { W.step = 3; renderWizard(el); };
  const submit = start => safe(async () => {
    if (!$('#agree').checked) return toast('Marque a confirmação de que os contatos aceitaram receber', true);
    $('#go').disabled = $('#draft').disabled = true;
    try {
      const r = await api('/api/campaigns', { body: {
        name: W.name, list_id: W.list.id, connection_id: W.conn.id, mode: W.mode, message: W.message,
        media_file: W.media?.file, media_type: W.media?.mime, media_name: W.media?.name, add_optout_footer: W.add_optout_footer,
        template_name: W.template?.name, template_lang: W.template?.language, template_params: W.tplParams,
        speed: W.speed, custom_min: W.custom_min, custom_max: W.custom_max, custom_every: W.custom_every, custom_pause: W.custom_pause,
        ai_enabled: W.mode === 'texto' && W.ai_enabled, ai_instructions: W.ai_instructions,
        business_hours: W.business_hours, scheduled_at: W.when === 'agendar' ? new Date(W.scheduled_at).toISOString() : null, start,
      } });
      W.done = true;
      toast(start ? (r.status === 'agendada' ? 'Campanha agendada!' : 'Disparo iniciado! 🚀') : 'Rascunho salvo');
      location.hash = '#/campanhas/' + r.id;
    } finally { $('#go') && ($('#go').disabled = $('#draft').disabled = false); }
  });
  $('#go').onclick = submit(true);
  $('#draft').onclick = submit(false);
}

// ---------------------------------------------------------------- campanhas
async function pageCampaigns(el) {
  el.innerHTML = `<div class="top"><div><h1>Campanhas</h1><p class="muted">Todos os seus disparos</p></div><a class="btn primary" href="#/nova">＋ Nova campanha</a></div><div id="list"><div class="spin"></div></div>`;
  every(async () => {
    const rows = await api('/api/campaigns');
    $('#list').innerHTML = rows.length ? `<div class="tablewrap"><table class="table">
      <tr><th>Campanha</th><th>Status</th><th style="width:220px">Progresso</th><th>Enviadas</th><th>Lidas</th><th>Responderam</th><th>Criada</th></tr>
      ${rows.map(c => `<tr class="click" data-id="${c.id}"><td><b>${esc(c.name)}</b><div class="tiny muted">${esc(c.list_name)} · ${CONN_TYPE[c.connection_type][0]} ${esc(c.connection_name)}</div></td>
        <td>${badge(CAMP_STATUS, c.status)}</td><td>${progressBar(c.stats)}<div class="tiny muted" style="margin-top:4px">${fmtN(c.stats.processado)} / ${fmtN(c.stats.total)}</div></td>
        <td>${fmtN(c.stats.sucesso)}</td><td>${fmtN(c.stats.lido)}</td><td>${fmtN(c.stats.respondeu)}</td><td class="small muted">${fmtDate(c.created_at)}</td></tr>`).join('')}</table></div>`
      : `<div class="card empty"><div class="big">📣</div><h2>Nenhuma campanha ainda</h2><p>Suba uma planilha e faça seu primeiro disparo em poucos minutos.</p><a class="btn primary" href="#/nova">Criar campanha</a></div>`;
    $$('[data-id]').forEach(r => r.onclick = () => location.hash = '#/campanhas/' + r.dataset.id);
  }, 4000);
}

async function pageCampaign(el, id) {
  let filter = '', page = 1;
  el.innerHTML = '<div class="spin"></div>';
  const draw = async () => {
    const [c, msgs] = await Promise.all([api('/api/campaigns/' + id), api(`/api/campaigns/${id}/messages?status=${filter}&page=${page}`)]);
    const s = c.stats;
    const active = ['enviando', 'agendada'].includes(c.status);
    el.innerHTML = `<div class="top"><div><a href="#/campanhas" class="small">← Campanhas</a><h1>${esc(c.name)}</h1>
      <div class="row">${badge(CAMP_STATUS, c.status)}<span class="small muted">${esc(c.list.name)} · ${CONN_TYPE[c.connection.type][0]} ${esc(c.connection.name)}</span></div></div>
      <div class="row">
        ${c.status === 'rascunho' ? '<button class="btn primary" data-act="start">▶ Iniciar</button>' : ''}
        ${active ? '<button class="btn" data-act="pause">⏸ Pausar</button>' : ''}
        ${c.status === 'pausada' ? '<button class="btn primary" data-act="resume">▶ Retomar</button>' : ''}
        ${s.falhou && ['concluida', 'pausada'].includes(c.status) ? '<button class="btn" data-act="retry">↻ Tentar falhas de novo</button>' : ''}
        ${s.total ? `<a class="btn" href="/api/campaigns/${c.id}/export">⬇ Baixar relatório</a>` : ''}
        ${!['concluida', 'cancelada'].includes(c.status) ? '<button class="btn danger" data-act="cancel">Cancelar</button>' : '<button class="btn danger" id="del">Apagar</button>'}
      </div></div>
      ${c.pause_reason && c.status !== 'concluida' ? `<div class="alert ${c.status === 'pausada' ? 'warn' : 'info'}" style="margin-bottom:14px">${c.status === 'pausada' ? '⏸' : '⏳'} ${esc(c.pause_reason)}${c.status === 'pausada' && c.connection.status !== 'conectado' ? ' <a href="#/conexoes">Ir para conexões</a>' : ''}</div>` : ''}
      ${c.status === 'agendada' ? `<div class="alert info" style="margin-bottom:14px">🗓️ Começa em ${fmtDate(c.scheduled_at)}</div>` : ''}
      <div class="card progwrap" style="margin-bottom:16px">
        ${ring('c' + c.id, pct(s.processado, s.total), c.status)}
        <div class="grow" style="min-width:0">
        <div style="text-transform:uppercase;letter-spacing:.12em;font-weight:800;font-size:12px;color:var(--roxo);margin-bottom:6px">Progresso do envio</div>
        <div class="row between" style="margin-bottom:10px"><b style="font-size:18px">${fmtN(s.processado)} de ${fmtN(s.total || c.list.valid)} contatos</b>
          <span class="muted small">${c.eta_seconds && s.pendente ? `⏱️ faltam ~${fmtDur(c.eta_seconds)}` : c.status === 'concluida' ? `Terminou em ${fmtDate(c.finished_at)}` : ''}</span></div>
        ${progressBar(s, true)}
        <div class="grid g4" style="margin-top:16px">
          ${[['📤', 'Enviadas', s.sucesso], ['📬', 'Entregues', s.entregue + s.lido], ['👀', 'Lidas', s.lido], ['💬', 'Responderam', s.respondeu]].map(([ic, l, v]) => `<div class="stat"><span style="font-size:20px">${ic}</span><div><div class="n">${fmtN(v)}</div><div class="small muted">${l}${s.sucesso && l !== 'Enviadas' ? ` · ${pct(v, s.sucesso)}%` : ''}</div></div></div>`).join('')}
        </div>
        <div class="row small muted" style="margin-top:12px;gap:18px"><span>⏳ Na fila: <b>${fmtN(s.pendente)}</b></span><span>❌ Falhas: <b>${fmtN(s.falhou)}</b></span><span>📵 Sem WhatsApp: <b>${fmtN(s.sem_whatsapp)}</b></span><span>🚫 Não enviados: <b>${fmtN(s.ignorado)}</b></span></div>
      </div></div>
      <div class="card">
        <div class="tabs">${[['', 'Todos'], ['sucesso', 'Enviados'], ['lido', 'Lidos'], ['respondeu', 'Responderam'], ['erro', 'Com erro'], ['pendente', 'Na fila'], ['ignorado', 'Não enviados']].map(([k, l]) => `<button class="tab ${filter === k ? 'on' : ''}" data-f="${k}">${l}</button>`).join('')}</div>
        ${msgs.rows.length ? `<div class="tablewrap"><table class="table"><tr><th>Contato</th><th>Situação</th><th>Enviado</th><th>Resposta</th></tr>
          ${msgs.rows.map(m => `<tr><td><b>${esc(m.name || '—')}</b><div class="tiny muted">${esc(m.phone_fmt)}</div></td><td>${badge(MSG_STATUS, m.status)}${m.error ? `<div class="tiny muted" style="margin-top:3px">${esc(m.error)}</div>` : ''}</td>
          <td class="small muted">${fmtDate(m.sent_at)}</td><td class="small">${m.replied ? `💬 ${esc((m.reply_text || '').slice(0, 80))}` : '<span class="muted">—</span>'}</td></tr>`).join('')}</table></div>
          ${msgs.pages > 1 ? `<div class="row" style="justify-content:center;margin-top:12px"><button class="btn sm" id="prev" ${page <= 1 ? 'disabled' : ''}>←</button><span class="small">Página ${page} de ${msgs.pages}</span><button class="btn sm" id="nextp" ${page >= msgs.pages ? 'disabled' : ''}>→</button></div>` : ''}`
          : `<div class="empty" style="padding:24px">${s.total ? 'Nada por aqui neste filtro' : 'A campanha ainda não começou'}</div>`}
      </div>`;
    $$('[data-act]').forEach(b => b.onclick = safe(async () => {
      if (b.dataset.act === 'cancel' && !confirm('Cancelar a campanha? Os contatos que ainda não receberam não vão receber.')) return;
      await api(`/api/campaigns/${id}/${b.dataset.act}`, { method: 'POST' }); draw().catch(() => {});
    }));
    $('#del') && ($('#del').onclick = safe(async () => { if (!confirm('Apagar a campanha e o relatório?')) return; await api('/api/campaigns/' + id, { method: 'DELETE' }); location.hash = '#/campanhas'; }));
    $$('[data-f]').forEach(t => t.onclick = () => { filter = t.dataset.f; page = 1; draw(); });
    $('#prev') && ($('#prev').onclick = () => { page--; draw(); });
    $('#nextp') && ($('#nextp').onclick = () => { page++; draw(); });
  };
  every(draw, 3000);
}

// ---------------------------------------------------------------- listas
async function pageLists(el) {
  const rows = await api('/api/lists');
  el.innerHTML = `<div class="top"><div><h1>Listas de contatos</h1><p class="muted">Planilhas que você já subiu</p></div><label class="btn primary">⬆ Subir planilha<input type="file" id="up" hidden accept=".xlsx,.xls,.csv,.txt"></label></div>
    ${rows.length ? `<div class="tablewrap"><table class="table"><tr><th>Lista</th><th>Linhas</th><th>Válidos</th><th>Inválidos</th><th>Repetidos</th><th>Enviada em</th></tr>
      ${rows.map(l => `<tr class="click" data-id="${l.id}"><td><b>${esc(l.name)}</b><div class="tiny muted">${l.columns.length} colunas</div></td><td>${fmtN(l.total)}</td><td><span class="badge ok">${fmtN(l.valid)}</span></td><td>${l.invalid ? `<span class="badge warn">${fmtN(l.invalid)}</span>` : '0'}</td><td>${fmtN(l.duplicates)}</td><td class="small muted">${fmtDate(l.created_at)}</td></tr>`).join('')}</table></div>`
      : `<div class="card empty"><div class="big">📋</div><h2>Nenhuma lista ainda</h2><p>Suba um Excel ou CSV com os telefones dos seus clientes.</p></div>`}`;
  $$('[data-id]').forEach(r => r.onclick = () => location.hash = '#/listas/' + r.dataset.id);
  $('#up').onchange = safe(async e => {
    toast('Lendo a planilha…');
    const up = await uploadFile(e.target.files[0], { temp: true });
    const l = await api('/api/lists/import', { body: { file: up.file } });
    location.hash = '#/listas/' + l.id;
  });
}
async function pageList(el, id) {
  let st = '', page = 1;
  const draw = async () => {
    const l = await api(`/api/lists/${id}?status=${st}&page=${page}`);
    el.innerHTML = `<div class="top"><div><a href="#/listas" class="small">← Listas</a><h1>${esc(l.name)}</h1><p class="muted">${fmtN(l.total)} linhas · ${fmtN(l.valid)} válidos · ${fmtN(l.invalid)} inválidos · ${fmtN(l.duplicates)} repetidos</p></div>
      <div class="row"><button class="btn primary" id="use">📣 Disparar para esta lista</button><a class="btn" href="/api/lists/${l.id}/export${st ? '?status=' + st : ''}">⬇ Exportar</a><button class="btn danger" id="del">Apagar</button></div></div>
      <div class="card"><div class="tabs">${[['', 'Todos'], ['valido', 'Válidos'], ['invalido', 'Inválidos'], ['duplicado', 'Repetidos']].map(([k, n]) => `<button class="tab ${st === k ? 'on' : ''}" data-s="${k}">${n}</button>`).join('')}</div>
      <div class="tablewrap"><table class="table"><tr><th>Linha</th><th>Situação</th><th>WhatsApp</th><th>Nome</th>${l.columns.filter(c => c.key !== l.phone_column && c.key !== l.name_column).slice(0, 4).map(c => `<th>${esc(c.label)}</th>`).join('')}</tr>
      ${l.contacts.map(c => `<tr><td class="muted">${c.row_number}</td><td>${c.status === 'valido' ? '<span class="badge ok">OK</span>' : `<span class="badge warn">${esc(c.error)}</span>`}</td><td>${esc(c.phone_fmt)}</td><td>${esc(c.name)}</td>
        ${l.columns.filter(x => x.key !== l.phone_column && x.key !== l.name_column).slice(0, 4).map(x => `<td>${esc(c.data[x.key])}</td>`).join('')}</tr>`).join('')}</table></div>
      ${l.pages > 1 ? `<div class="row" style="justify-content:center;margin-top:12px"><button class="btn sm" id="prev" ${page <= 1 ? 'disabled' : ''}>←</button><span class="small">Página ${page} de ${l.pages}</span><button class="btn sm" id="nextp" ${page >= l.pages ? 'disabled' : ''}>→</button></div>` : ''}</div>`;
    $$('[data-s]').forEach(t => t.onclick = () => { st = t.dataset.s; page = 1; draw(); });
    $('#prev') && ($('#prev').onclick = () => { page--; draw(); });
    $('#nextp') && ($('#nextp').onclick = () => { page++; draw(); });
    $('#use').onclick = safe(async () => { newWizard(); W.list = await api('/api/lists/' + id); location.hash = '#/nova'; });
    $('#del').onclick = safe(async () => { if (!confirm('Apagar esta lista?')) return; await api('/api/lists/' + id, { method: 'DELETE' }); location.hash = '#/listas'; });
  };
  await draw();
}

// ---------------------------------------------------------------- conexões
async function pageConnections(el) {
  el.innerHTML = `<div class="top"><div><h1>Conexões</h1><p class="muted">Os números de WhatsApp que fazem os disparos</p></div><button class="btn primary" id="add">＋ Conectar WhatsApp</button></div><div id="cl"></div>`;
  $('#add').onclick = () => addConnection(el);
  every(async () => {
    const rows = await api('/api/connections');
    $('#cl').innerHTML = rows.length ? `<div class="grid g3">${rows.map(c => `<div class="card stack">
      <div class="row between"><b style="font-size:16px">${CONN_TYPE[c.type][0]} ${esc(c.name)}</b>${badge(CONN_STATUS, c.status)}</div>
      <div class="small muted">${CONN_TYPE[c.type][1]}${c.phone_fmt ? ' · ' + esc(c.phone_fmt) : ''}${c.meta?.verified_name ? ' · ' + esc(c.meta.verified_name) : ''}</div>
      ${c.meta?.quality_rating ? `<div class="small">Qualidade do número na Meta: <b>${esc(c.meta.quality_rating)}</b></div>` : ''}
      ${c.last_error ? `<div class="alert err small">${esc(c.last_error)}</div>` : ''}
      ${c.type === 'qr' ? (c.engine_online ? '<div class="small">💻 Mantida pelo app do PC <span class="badge ok plain">ligado</span></div>'
        : `<div class="alert warn small"><span>💻</span><div>O QR Code funciona pelo <b>app Domma Connect Lead no computador</b>. ${c.engine_linked ? 'Abra o app no PC onde este número foi conectado.' : 'Abra o app para conectar.'} <a href="#/app">Baixar o app</a></div></div>`) : ''}
      <div class="row">
        ${c.type === 'qr' && c.status !== 'conectado' ? `<button class="btn sm primary" data-qr="${c.id}">📷 Ler QR Code</button>` : ''}
        ${c.type === 'oficial' ? `<button class="btn sm" data-edit="${c.id}">Editar dados</button><button class="btn sm" data-test="${c.id}">Testar</button>` : ''}
        ${c.type === 'qr' && c.status === 'conectado' ? `<button class="btn sm" data-out="${c.id}">Desconectar</button>` : ''}
        <button class="btn sm ghost danger" data-del="${c.id}">Remover</button></div></div>`).join('')}</div>`
      : `<div class="card empty"><div class="big">🔌</div><h2>Nenhum WhatsApp conectado</h2><p>Conecte pela API Oficial da Meta (mais seguro) ou lendo um QR Code (mais rápido de começar).</p><button class="btn primary" id="add2">Conectar agora</button></div>`;
    $('#add2') && ($('#add2').onclick = () => addConnection(el));
    $$('[data-qr]').forEach(b => b.onclick = safe(async () => { await api(`/api/connections/${b.dataset.qr}/connect`, { method: 'POST' }); qrModal(b.dataset.qr); }));
    $$('[data-out]').forEach(b => b.onclick = safe(async () => { if (!confirm('Desconectar este WhatsApp?')) return; await api(`/api/connections/${b.dataset.out}/disconnect`, { method: 'POST' }); toast('Desconectado'); }));
    $$('[data-test]').forEach(b => b.onclick = safe(async () => { await api(`/api/connections/${b.dataset.test}/connect`, { method: 'POST' }); toast('Teste concluído — veja o status no cartão'); }));
    $$('[data-edit]').forEach(b => b.onclick = () => oficialForm(rows.find(c => c.id == b.dataset.edit)));
    $$('[data-del]').forEach(b => b.onclick = safe(async () => { if (!confirm('Remover esta conexão?')) return; await api('/api/connections/' + b.dataset.del, { method: 'DELETE' }); toast('Conexão removida'); }));
  }, 4000);
}
function addConnection() {
  const m = modal(`<div class="row between"><h2 style="margin:0">Como você quer conectar?</h2><button class="btn ghost sm" data-close>✕</button></div>
    <div class="stack" style="margin-top:14px">
      <div class="opt" data-t="oficial"><div class="t">✅ API Oficial da Meta <span class="badge ok plain">mais seguro</span></div><div class="small muted">Sem risco de banimento por usar ferramenta. Exige conta no Meta Business e modelos aprovados. A Meta cobra por conversa.</div></div>
      <div class="opt" data-t="qr"><div class="t">📱 QR Code <span class="badge roxo plain">começa em 1 minuto</span></div><div class="small muted">Use o WhatsApp que você já tem, lendo um QR Code como no WhatsApp Web. Sem custo por mensagem, mas há risco de bloqueio se a lista for fria ou houver denúncias.</div></div>
      <div class="opt" data-t="simulado"><div class="t">🧪 Conexão de teste</div><div class="small muted">Para conhecer o sistema. Simula os envios — nada é enviado de verdade.</div></div>
    </div>`);
  $$('[data-t]', m).forEach(o => o.onclick = safe(async () => {
    const t = o.dataset.t; m.close();
    if (t === 'oficial') return oficialForm();
    const c = await api('/api/connections', { body: { type: t } });
    if (t === 'qr') qrModal(c.id); else toast('Conexão de teste criada');
  }));
}
function qrModal(id) {
  const m = modal(`<div class="row between"><h2 style="margin:0">Conectar pelo QR Code</h2><button class="btn ghost sm" data-close>✕</button></div>
    <div class="grid g2" style="margin-top:12px;align-items:center"><div class="qrbox" id="qr"><div class="spin"></div></div>
    <ol class="small" style="line-height:1.9;padding-left:18px"><li>Abra o WhatsApp no celular</li><li>Toque em <b>⋮ Mais opções</b> ou <b>Configurações</b></li><li>Toque em <b>Dispositivos conectados</b> → <b>Conectar dispositivo</b></li><li>Aponte a câmera para este código</li></ol></div>
    <p class="small muted" id="qrst" style="text-align:center">Gerando o QR Code…</p>`);
  const t = setInterval(safe(async () => {
    const r = await api(`/api/connections/${id}/qr`);
    if (r.status === 'conectado') { clearInterval(t); m.close(); toast(`WhatsApp conectado! ${r.phone_fmt || ''}`); return; }
    if (!r.engine_online && !r.qr) { $('#qr', m).innerHTML = '<div style="font-size:54px">💻</div>'; $('#qrst', m).innerHTML = 'Para ler o QR Code, abra o <b>app Domma Connect Lead</b> no computador e entre com a sua conta. <a href="#/app">Baixar o app para Windows</a>'; return; }
    if (r.qr) { $('#qr', m).innerHTML = `<img src="${r.qr}" alt="QR Code">`; $('#qrst', m).textContent = 'O código se renova sozinho. Mantenha esta janela aberta.'; }
    if (r.last_error && r.status === 'erro') $('#qrst', m).textContent = r.last_error;
  }), 2000);
  m.onclose = () => clearInterval(t);
}
function oficialForm(conn) {
  const m = modal(`<div class="row between"><h2 style="margin:0">API Oficial da Meta</h2><button class="btn ghost sm" data-close>✕</button></div>
    <form class="stack" id="of" style="margin-top:12px">
      <label class="f">Nome da conexão<input name="name" value="${esc(conn?.name || 'WhatsApp API Oficial')}"></label>
      <label class="f">ID do número de telefone<span class="h">Meta for Developers → WhatsApp → Configuração da API (Phone number ID)</span><input name="phone_number_id" required value="${esc(conn?.config?.phone_number_id || '')}"></label>
      <label class="f">ID da conta do WhatsApp Business (WABA)<span class="h">Necessário para listar seus modelos aprovados</span><input name="waba_id" required value="${esc(conn?.config?.waba_id || '')}"></label>
      <label class="f">Token de acesso permanente<span class="h">Gerado com um usuário do sistema no Gerenciador de Negócios${conn?.config?.has_token ? ' — deixe em branco para manter o atual' : ''}</span><input name="access_token" type="password" ${conn ? '' : 'required'} autocomplete="off"></label>
      <div class="alert info small">Depois de salvar, configure o webhook na Meta para receber entregues, lidos e respostas: veja no <a href="#/admin/webhook">Administrador → Webhook</a>.</div>
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" data-close>Cancelar</button><button class="btn primary">Salvar e testar</button></div></form>`);
  $('#of', m).onsubmit = safe(async e => {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.target));
    const body = { name: f.name, config: { phone_number_id: f.phone_number_id, waba_id: f.waba_id, access_token: f.access_token } };
    const c = conn ? await api('/api/connections/' + conn.id, { method: 'PATCH', body }) : await api('/api/connections', { body: { type: 'oficial', ...body } });
    m.close();
    toast(c.status === 'conectado' ? 'API Oficial conectada ✅' : 'Salvo, mas a Meta recusou: ' + (c.last_error || 'verifique os dados'), c.status !== 'conectado');
  });
}

// ---------------------------------------------------------------- app para PC (área privada)
async function pageDesktop(el) {
  el.innerHTML = `<div class="top"><div><h1>App para PC</h1><p class="muted">O motor de envio do Domma Connect Lead para Windows</p></div></div><div id="dk"><div class="spin"></div></div>`;
  every(async () => {
    const s = await api('/api/engine/status');
    $('#dk').innerHTML = `<div class="grid g2">
      <div class="card stack"><div class="row" style="gap:14px"><img src="/brand/simbolo.png" style="height:52px" alt=""><div><h2 style="margin:0">Domma Connect Lead para Windows</h2><div class="small muted">Versão ${esc(s.version)} · Windows 10 ou 11 (64 bits)</div></div></div>
        <p>O app mantém o seu <b>WhatsApp por QR Code</b> conectado e faz os disparos das campanhas direto do seu computador. Ele abre este mesmo painel, então tudo fica num lugar só.</p>
        ${IN_DESKTOP ? '<div class="alert ok">✅ Você já está usando o app. Pode minimizar: ele continua enviando na bandeja do Windows (perto do relógio).</div>'
          : `<a class="btn primary big" href="${esc(s.download_url)}" style="text-align:center">⬇ Baixar instalador (.exe)</a>`}
        <ol class="small" style="line-height:1.9;padding-left:18px;margin:0"><li>Baixe e abra o instalador. Se o Windows avisar, clique em <b>Mais informações → Executar assim mesmo</b>.</li>
          <li>Entre com o mesmo e-mail e senha deste painel.</li><li>Em <b>Conexões</b>, leia o QR Code com o celular.</li>
          <li>Deixe o app aberto (ou minimizado) enquanto as campanhas por QR Code estiverem rodando.</li></ol></div>
      <div class="card stack"><h2 style="margin:0">Computadores conectados</h2>
        ${s.engines.length ? s.engines.map(e => `<div class="row between" style="padding:8px 0;border-bottom:1px solid #f0eef6"><span>💻 <b>${esc(e.name || 'Computador')}</b> <span class="tiny muted">v${esc(e.version || '?')}</span></span>
          ${e.online ? '<span class="badge ok">ligado agora</span>' : `<span class="badge plain">visto ${fmtDate(new Date(e.last_seen).toISOString())}</span>`}</div>`).join('')
          : '<p class="muted">Nenhum computador ainda. Instale o app e entre com a sua conta.</p>'}
        <div class="alert info small">API Oficial e conexão de teste também enviam com este painel aberto no navegador. O QR Code precisa do app aberto no PC onde o número foi conectado.</div></div></div>`;
  }, 5000);
}

// ---------------------------------------------------------------- descadastrados
async function pageOptouts(el) {
  const draw = async () => {
    const rows = await api('/api/optouts');
    el.innerHTML = `<div class="top"><div><h1>Descadastrados</h1><p class="muted">Quem respondeu SAIR (ou similar) nunca mais recebe disparos — isso protege seu número.</p></div></div>
      <div class="card" style="margin-bottom:16px"><form class="row" id="f"><input name="phone" placeholder="Adicionar telefone manualmente, ex.: (31) 99999-9999" class="grow" style="width:auto"><button class="btn primary">Adicionar</button></form></div>
      ${rows.length ? `<div class="tablewrap"><table class="table"><tr><th>Telefone</th><th>Motivo</th><th>Desde</th><th></th></tr>
        ${rows.map(o => `<tr><td><b>${esc(o.phone_fmt)}</b></td><td class="small">${esc(o.reason)}</td><td class="small muted">${fmtDate(o.created_at)}</td><td style="text-align:right"><button class="btn sm ghost" data-rm="${o.phone}">Remover</button></td></tr>`).join('')}</table></div>`
        : '<div class="card empty"><div class="big">🙌</div>Ninguém pediu para sair até agora.</div>'}`;
    $('#f').onsubmit = safe(async e => { e.preventDefault(); await api('/api/optouts', { body: { phone: e.target.phone.value } }); toast('Adicionado'); draw(); });
    $$('[data-rm]').forEach(b => b.onclick = safe(async () => { if (!confirm('Esta pessoa voltará a receber mensagens. Confirmar?')) return; await api('/api/optouts/' + b.dataset.rm, { method: 'DELETE' }); draw(); }));
  };
  await draw();
}


// ---------------------------------------------------------------- administrador
const ADMIN_TABS = [
  ['perfil', '🏢', 'Perfil da empresa'], ['playbook', '🎯', 'Playbook de vendas'], ['ia', '✨', 'Inteligência artificial'],
  ['disparo', '⏱️', 'Tempo de disparo'], ['digitacao', '⌨️', 'Digitação'], ['galeria', '🖼️', 'Galeria'], ['webhook', '🔗', 'Webhook (API Oficial)'],
];
async function pageAdmin(el, _alias, tab = 'perfil') {
  if (!ADMIN_TABS.some(t => t[0] === tab)) tab = 'perfil';
  const [A, S] = await Promise.all([api('/api/admin'), api('/api/settings')]);
  el.innerHTML = `<div class="top"><div><h1>Administrador</h1><p class="muted">Tudo o que controla como o sistema escreve e dispara</p></div></div>
    <div class="grid" style="grid-template-columns:230px minmax(0,1fr);align-items:start">
      <div class="card" style="padding:8px">${ADMIN_TABS.map(([k, ic, l]) => `<a href="#/admin/${k}" class="row" style="gap:10px;padding:10px 12px;border-radius:10px;color:${tab === k ? 'var(--roxo)' : 'var(--texto)'};background:${tab === k ? 'var(--roxo-bg)' : 'transparent'};font-weight:600"><span>${ic}</span>${l}</a>`).join('')}</div>
      <div id="adm"></div></div>`;
  const box = $('#adm');
  const save = (section, data, msg = 'Salvo ✅') => safe(async () => { await api('/api/admin/' + section, { method: 'PATCH', body: data }); toast(msg); me = null; await router(); })();
  const field = (name, label, val, { hint, ph, type = 'text', area, rows } = {}) => `<label class="f">${label}${hint ? `<span class="h">${hint}</span>` : ''}${area
    ? `<textarea name="${name}" style="min-height:${rows || 110}px" placeholder="${esc(ph || '')}">${esc(val)}</textarea>`
    : `<input name="${name}" type="${type}" value="${esc(val)}" placeholder="${esc(ph || '')}">`}</label>`;
  const formData = f => Object.fromEntries(new FormData(f));

  if (tab === 'perfil') {
    const p = A.perfil;
    box.innerHTML = `<form class="card stack" id="f"><h2>🏢 Perfil da empresa</h2>
      <div class="row" style="gap:16px"><div style="width:84px;height:84px;border-radius:18px;background:var(--roxo-bg);display:grid;place-items:center;overflow:hidden;border:1px solid var(--borda)">${p.logo ? `<img src="/media/${esc(p.logo)}" style="width:100%;height:100%;object-fit:cover">` : '<span style="font-size:34px">🏢</span>'}</div>
        <div><label class="btn sm">📷 ${p.logo ? 'Trocar foto/logo' : 'Enviar foto ou logo'}<input type="file" id="logo" hidden accept="image/*"></label><div class="tiny muted" style="margin-top:6px">Aparece no menu do sistema. PNG ou JPG.</div></div></div>
      <div class="grid g2">${field('nome', 'Nome da empresa', p.nome)}${field('segmento', 'Segmento', p.segmento, { ph: 'Ex.: Vistoria e pesquisa veicular' })}
        ${field('cidade', 'Cidade / região de atuação', p.cidade, { ph: 'Ex.: Minas Gerais' })}${field('telefone', 'Telefone de contato', p.telefone)}
        ${field('site', 'Site', p.site, { ph: 'https://' })}${field('instagram', 'Instagram', p.instagram, { ph: '@suaempresa' })}</div>
      ${field('descricao', 'Sobre a empresa', p.descricao, { area: true, rows: 140, hint: 'Conte em poucas linhas quem vocês são. A IA usa isso para escrever as mensagens.', ph: 'Ex.: Somos a Master Laudo, rede com mais de 100 lojas de vistoria em MG…' })}
      <div><button class="btn primary">Salvar perfil</button></div></form>`;
    $('#f').onsubmit = e => { e.preventDefault(); save('perfil', formData(e.target)); };
    $('#logo').onchange = safe(async e => { const up = await uploadFile(e.target.files[0]); await api('/api/admin/logo', { body: { file: up.file } }); toast('Logo atualizada'); me = null; router(); });
  }

  if (tab === 'playbook') {
    const b = A.playbook;
    const tons = ['Amigável e direto, como um vendedor atencioso', 'Formal e profissional', 'Descontraído, com bom humor', 'Consultivo, que tira dúvidas antes de vender'];
    box.innerHTML = `<div class="grid" style="grid-template-columns:minmax(0,1fr) 320px;align-items:start"><form class="card stack" id="f"><h2>🎯 Playbook de vendas</h2>
      <p class="small muted" style="margin-top:-6px">O “manual” que a IA segue para escrever como o seu melhor vendedor. Quanto mais completo, melhores as mensagens.</p>
      ${field('produtos', 'Produtos e serviços', b.produtos, { area: true, hint: 'Um por linha. Inclua preço só se puder ser divulgado.', ph: 'Vistoria de transferência — laudo na hora\nLaudo cautelar\nPesquisa veicular completa' })}
      ${field('publico', 'Para quem você vende', b.publico, { area: true, rows: 80, ph: 'Ex.: Quem está comprando ou vendendo carro usado; lojistas de veículos' })}
      ${field('diferenciais', 'Diferenciais', b.diferenciais, { area: true, rows: 80, ph: 'Ex.: Mais de 100 lojas em MG, laudo na hora, atendimento aos sábados' })}
      ${field('objecoes', 'Objeções comuns e como responder', b.objecoes, { area: true, ph: '"Está caro" → explique que o laudo evita prejuízo na compra\n"Não tenho tempo" → atendimento rápido, sem agendamento' })}
      <label class="f">Tom de voz<input name="tom" list="tons" value="${esc(b.tom)}"><datalist id="tons">${tons.map(t => `<option value="${esc(t)}">`).join('')}</datalist></label>
      ${field('cta', 'Chamada para ação padrão', b.cta, { ph: 'Ex.: Perguntar se o cliente quer reservar um horário' })}
      ${field('proibidas', 'Palavras ou assuntos proibidos', b.proibidas, { ph: 'Ex.: grátis, garantido, concorrentes' })}
      ${field('exemplos', 'Exemplos de mensagens que funcionam', b.exemplos, { area: true, hint: 'Opcional — a IA se inspira no estilo' })}
      <div class="row"><button class="btn primary">Salvar playbook</button></div></form>
      <div class="card stack"><h3>✨ Testar o playbook</h3><p class="small muted">Veja como a IA escreveria com o que está salvo.</p>
        <textarea id="tins" style="min-height:80px" placeholder="Objetivo do teste. Ex.: Ofereça a vistoria de transferência"></textarea>
        <button class="btn sm primary" id="tgo" ${S.ai_has_key ? '' : 'disabled'}>Gerar exemplo</button>
        ${S.ai_has_key ? '' : '<div class="tiny muted">Configure uma IA na aba Inteligência artificial.</div>'}
        <div id="tout"></div></div></div>`;
    $('#f').onsubmit = e => { e.preventDefault(); save('playbook', formData(e.target)); };
    $('#tgo').onclick = safe(async () => {
      $('#tout').innerHTML = '<div class="spin"></div>';
      try {
        const r = await api('/api/ai/preview', { body: { message: '', instructions: $('#tins').value || 'Apresente a empresa e convide para uma conversa' } });
        $('#tout').innerHTML = `<div class="bubble" style="margin:0;max-width:100%">${waFormat(r.previews[0].texto || r.previews[0].erro)}<span class="tm">agora</span></div><div class="tiny muted" style="margin-top:6px">Salve o playbook antes de testar alterações.</div>`;
      } catch (e) { $('#tout').innerHTML = ''; throw e; }
    });
  }

  if (tab === 'ia') {
    const ia = A.ia, P = ia.provedores;
    const opt = (sel, allowNone) => `${allowNone ? `<option value="">Nenhuma</option>` : ''}${Object.entries(P).map(([k, v]) => `<option value="${k}" ${sel === k ? 'selected' : ''}>${esc(v.label)}</option>`).join('')}`;
    box.innerHTML = `<div class="stack"><form class="card stack" id="f"><h2>✨ Inteligência artificial</h2>
      <p class="small muted" style="margin-top:-6px">A IA personaliza cada mensagem com os dados do contato e o seu playbook. Se a principal falhar, o sistema usa a reserva automaticamente.</p>
      <div class="grid g2"><label class="f">IA principal<select name="principal">${opt(ia.principal)}</select></label><label class="f">IA de reserva<select name="reserva">${opt(ia.reserva, true)}</select></label>
        <label class="f">Criatividade<select name="criatividade">${[['conservadora', 'Conservadora — mais próxima da mensagem base'], ['equilibrada', 'Equilibrada'], ['criativa', 'Criativa — textos mais variados']].map(([k, l]) => `<option value="${k}" ${ia.criatividade === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
        <label class="f">Tamanho das mensagens<select name="tamanho">${[['curta', 'Curta (até ~3 frases)'], ['media', 'Média (até ~5 frases)']].map(([k, l]) => `<option value="${k}" ${ia.tamanho === k ? 'selected' : ''}>${l}</option>`).join('')}</select></label></div>
      <div><button class="btn primary">Salvar preferências</button></div></form>
      <div class="grid g3">${Object.entries(P).map(([k, v]) => `<form class="card stack" data-prov="${k}">
        <div class="row between"><b>${esc(v.label)}</b>${v.has_key ? '<span class="badge ok">Chave salva</span>' : '<span class="badge plain">Sem chave</span>'}</div>
        <label class="f">Chave de API<input name="key" type="password" autocomplete="off" placeholder="${v.has_key ? '•••••••• (manter a atual)' : 'Cole a chave aqui'}"></label>
        <label class="f">Modelo<span class="h">Em branco = ${esc(v.default_model)}</span><input name="model" value="${esc(v.model)}" placeholder="${esc(v.default_model)}"></label>
        <div class="row" style="gap:6px"><button class="btn sm primary">Salvar</button><button type="button" class="btn sm" data-test="${k}" ${v.has_key ? '' : 'disabled'}>Testar</button>${v.has_key ? `<button type="button" class="btn sm ghost danger" data-rmkey="${k}">Remover chave</button>` : ''}</div></form>`).join('')}</div>
      <div class="alert info small">🔒 As chaves ficam guardadas criptografadas e nunca aparecem de novo na tela. O custo de uso é cobrado pelo provedor na sua conta.</div></div>`;
    $('#f').onsubmit = e => { e.preventDefault(); save('ia', formData(e.target)); };
    $$('[data-prov]').forEach(f => f.onsubmit = e => { e.preventDefault(); const d = formData(f); save('ia', { provedores: { [f.dataset.prov]: d } }, 'IA salva ✅'); });
    $$('[data-test]').forEach(b => b.onclick = safe(async () => { b.disabled = true; try { const r = await api('/api/admin/test-ai', { body: { provider: b.dataset.test } }); toast(`Funcionando ✅ ${r.provider} · ${r.model}`); } finally { b.disabled = false; } }));
    $$('[data-rmkey]').forEach(b => b.onclick = () => confirm('Remover a chave desta IA?') && save('ia', { provedores: { [b.dataset.rmkey]: { remove_key: true } } }, 'Chave removida'));
  }

  if (tab === 'disparo') {
    const d = A.disparo;
    const DN = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
    box.innerHTML = `<form class="card stack" id="f"><h2>⏱️ Tempo de disparo</h2>
      <p class="small muted" style="margin-top:-6px">Padrões usados nas novas campanhas. Em cada campanha dá para ajustar.</p>
      <div><b>Velocidade padrão</b><div class="grid g4" style="margin-top:8px">${[['segura', '🛡️ Segura'], ['normal', '🚗 Normal'], ['rapida', '🚀 Rápida'], ['personalizado', '🎛️ Personalizado']].map(([k, l]) => `<label class="opt ${d.velocidade_padrao === k ? 'on' : ''}"><input type="radio" name="velocidade_padrao" value="${k}" ${d.velocidade_padrao === k ? 'checked' : ''}><div class="t">${l}</div></label>`).join('')}</div></div>
      <div class="card flat" style="background:var(--roxo-bg);border-color:#e2d9fb"><b>🎛️ Intervalo personalizado</b>
        <div class="row" style="margin-top:10px;gap:8px">Entre <input name="custom_min" type="number" min="1" style="width:90px" value="${d.custom_min}"> e <input name="custom_max" type="number" min="1" style="width:90px" value="${d.custom_max}"> segundos entre cada mensagem</div>
        <div class="row" style="margin-top:8px;gap:8px">Pausa de <input name="custom_pause" type="number" min="0" style="width:80px" value="${d.custom_pause}"> minutos a cada <input name="custom_every" type="number" min="0" style="width:80px" value="${d.custom_every}"> mensagens <span class="tiny muted">(0 = sem pausa)</span></div>
        <div class="tiny muted" style="margin-top:8px">O sistema sorteia um tempo dentro do intervalo para cada envio — fica mais natural e protege o número.</div></div>
      <div class="grid g2">
        <label class="f">Limite diário por número<span class="h">0 = sem limite. Ao atingir, a campanha continua sozinha no dia seguinte.</span><input name="limite_diario" type="number" min="0" value="${d.limite_diario}"></label>
        <label class="f">Texto de descadastro<span class="h">Vai no fim da mensagem quando a opção estiver ligada</span><input name="rodape_optout" value="${esc(d.rodape_optout)}"></label></div>
      <div><b>Horário permitido para disparar</b>
        <div class="row" style="margin-top:8px;gap:8px">Das <input name="horario_inicio" type="number" min="0" max="23" style="width:76px" value="${d.horario_inicio}"> h às <input name="horario_fim" type="number" min="1" max="24" style="width:76px" value="${d.horario_fim}"> h (horário de Brasília)</div>
        <div class="row" style="margin-top:10px;gap:6px">${DN.map((n, i) => `<label class="chip" style="${d.dias.includes(i) ? 'background:var(--roxo);color:#fff;border-color:var(--roxo)' : ''}"><input type="checkbox" name="dia" value="${i}" ${d.dias.includes(i) ? 'checked' : ''} hidden>${n}</label>`).join('')}</div>
        <label class="switch" style="margin-top:12px"><input type="checkbox" name="horario_padrao_ligado" ${d.horario_padrao_ligado ? 'checked' : ''}><i></i> Novas campanhas já vêm com “respeitar horário” ligado</label></div>
      <div><button class="btn primary">Salvar tempos</button></div></form>`;
    $$('#f .opt input').forEach(r => r.onchange = () => { $$('#f .opt').forEach(o => o.classList.toggle('on', o.querySelector('input').checked)); });
    $$('#f [name=dia]').forEach(c => c.onchange = () => { const l = c.parentElement; l.style.cssText = c.checked ? 'background:var(--roxo);color:#fff;border-color:var(--roxo)' : ''; });
    $('#f').onsubmit = e => {
      e.preventDefault();
      const fd = new FormData(e.target);
      const data = Object.fromEntries([...fd].filter(([k]) => k !== 'dia'));
      data.dias = fd.getAll('dia').map(Number);
      data.horario_padrao_ligado = fd.has('horario_padrao_ligado');
      save('disparo', data);
    };
  }

  if (tab === 'digitacao') {
    const t = A.digitacao;
    box.innerHTML = `<form class="card stack" id="f"><h2>⌨️ Simulação de digitação</h2>
      <p class="small muted" style="margin-top:-6px">Antes de cada mensagem, o contato vê “digitando…” por alguns segundos, como se uma pessoa estivesse escrevendo. Vale para conexões por QR Code.</p>
      <label class="switch"><input type="checkbox" name="ligado" ${t.ligado ? 'checked' : ''}><i></i> Mostrar “digitando…” antes de enviar</label>
      <label class="f">Velocidade de digitação: <b id="vlab">${t.velocidade} caracteres por segundo</b><input name="velocidade" type="range" min="5" max="60" value="${t.velocidade}" style="padding:0"></label>
      <div class="grid g2"><label class="f">Tempo mínimo digitando (segundos)<input name="min" type="number" step="0.5" min="0" value="${t.min}"></label>
        <label class="f">Tempo máximo digitando (segundos)<input name="max" type="number" step="0.5" min="0" value="${t.max}"></label></div>
      <div class="alert info small" id="ex"></div>
      <div><button class="btn primary">Salvar digitação</button></div></form>`;
    const calc = () => {
      const f = $('#f'), v = Number(f.velocidade.value), mn = Number(f.min.value), mx = Number(f.max.value);
      $('#vlab').textContent = `${v} caracteres por segundo`;
      const ex = n => Math.min(mx, Math.max(mn, n / v)).toFixed(1);
      $('#ex').innerHTML = `Exemplo: mensagem curta (80 caracteres) ≈ <b>${ex(80)} s</b> digitando · mensagem longa (400 caracteres) ≈ <b>${ex(400)} s</b>`;
    };
    $$('#f input').forEach(i => i.oninput = calc); calc();
    $('#f').onsubmit = e => { e.preventDefault(); const d = formData(e.target); d.ligado = e.target.ligado.checked; save('digitacao', d); };
  }

  if (tab === 'galeria') {
    const g = A.galeria;
    box.innerHTML = `<div class="card stack"><div class="row between"><div><h2 style="margin:0">🖼️ Galeria da empresa</h2><p class="small muted">Fotos, folders, tabelas e vídeos para anexar nas campanhas com um clique.</p></div>
      <form class="row" id="up"><input name="titulo" placeholder="Título (opcional)" style="width:200px"><label class="btn primary">⬆ Enviar arquivo<input type="file" name="file" hidden accept="image/*,video/*,audio/*,application/pdf"></label></form></div>
      ${g.length ? `<div class="grid g4">${g.map(x => `<div class="card flat" style="padding:10px">${x.mime.startsWith('image/') ? `<img src="/media/${esc(x.file)}" style="width:100%;height:130px;object-fit:cover;border-radius:10px">` : `<div style="height:130px;display:grid;place-items:center;font-size:44px;background:var(--roxo-bg);border-radius:10px">${x.mime.startsWith('video/') ? '🎬' : x.mime.startsWith('audio/') ? '🎵' : '📄'}</div>`}
        <div class="row between" style="margin-top:8px"><div class="small" style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px" title="${esc(x.name)}">${esc(x.titulo)}</div><button class="btn sm ghost danger" data-del="${esc(x.file)}">✕</button></div></div>`).join('')}</div>`
        : '<div class="empty"><div class="big">🖼️</div>Nenhum arquivo ainda. Envie a logo, fotos da loja ou um folder de serviços.</div>'}</div>`;
    $('#up [name=file]').onchange = safe(async e => { toast('Enviando…'); const up = await uploadFile(e.target.files[0]); await api('/api/admin/galeria', { body: { file: up.file, titulo: $('#up [name=titulo]').value } }); pageAdmin(el, null, 'galeria'); });
    $$('[data-del]').forEach(b => b.onclick = safe(async () => { if (!confirm('Remover da galeria?')) return; await api('/api/admin/galeria/' + b.dataset.del, { method: 'DELETE' }); pageAdmin(el, null, 'galeria'); }));
  }

  if (tab === 'webhook') {
    box.innerHTML = `<div class="card stack"><h2>🔗 Webhook da API Oficial</h2>
      <p class="small muted">No app da Meta (WhatsApp → Configuração → Webhook), cole os dados abaixo e assine o campo <b>messages</b>. Assim o sistema recebe entregues, lidos, respostas e pedidos de SAIR.</p>
      <label class="f">URL de retorno<div class="copy"><input readonly value="${esc(S.webhook_url)}"><button class="btn sm" data-copy="${esc(S.webhook_url)}">Copiar</button></div></label>
      <label class="f">Token de verificação<div class="copy"><input readonly value="${esc(S.webhook_token)}"><button class="btn sm" data-copy="${esc(S.webhook_token)}">Copiar</button></div></label></div>`;
    $$('[data-copy]').forEach(b => b.onclick = () => { navigator.clipboard.writeText(b.dataset.copy); toast('Copiado'); });
  }
}

router();
