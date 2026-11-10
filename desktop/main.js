// Domma Connect Lead para Windows.
// Abre o painel (o mesmo site da Vercel) numa janela e roda o motor de envio em segundo plano:
// mantém o WhatsApp por QR Code conectado e faz os envios das campanhas.
import { app, BrowserWindow, Tray, Menu, nativeImage, session, shell, Notification } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Engine } from './engine/engine.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.join(here, 'config.json'), 'utf8'));
const APP_URL = (process.env.DOMMA_APP_URL || config.appUrl).replace(/\/$/, '');
const ICON = nativeImage.createFromPath(path.join(here, 'build', 'icon.png'));

let win = null, tray = null, engine = null, token = null, quitting = false, lastState = null;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => showWindow());
app.setAppUserModelId('br.com.domma.connectlead');

async function readToken() {
  const [c] = await session.defaultSession.cookies.get({ url: APP_URL, name: 'cl_token' });
  token = c?.value || null;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280, height: 860, minWidth: 380, minHeight: 600, icon: ICON, title: 'Domma Connect Lead',
    backgroundColor: '#1e1136', autoHideMenuBar: true, show: false,
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.webContents.setUserAgent(`${win.webContents.getUserAgent()} DommaConnectLead/${app.getVersion()}`);
  win.loadURL(APP_URL);
  win.once('ready-to-show', () => win.show());
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(here, 'offline.html'), { query: { url: APP_URL } });
  });
  // links externos e downloads (planilhas exportadas) abrem no navegador / salvam normalmente
  win.webContents.setWindowOpenHandler(({ url }) => { if (!url.startsWith(APP_URL)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith(APP_URL) && !url.startsWith('file:')) { e.preventDefault(); shell.openExternal(url); } });
  // fechar a janela só esconde: o motor continua enviando na bandeja
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (Notification.isSupported() && !app._hintShown) {
      app._hintShown = true;
      new Notification({ title: 'Domma Connect Lead continua ligado', body: 'Os envios seguem por aqui. Para sair de vez, clique no ícone perto do relógio → Sair.', icon: ICON }).show();
    }
  });
}

function showWindow() {
  if (!win) createWindow();
  win.show(); win.focus();
}

function statusLabel(s) {
  if (!s) return 'Iniciando…';
  if (!s.logged && !s.online) return s.error && !/login/i.test(s.error) ? `Sem internet ou servidor fora: ${s.error}` : 'Entre com a sua conta no painel';
  const on = s.connections.filter(c => c.status === 'conectado').length;
  return `Ligado · ${on} WhatsApp conectado(s) · ${s.sent} enviada(s) desde que abriu`;
}

function buildTray() {
  const menu = Menu.buildFromTemplate([
    { label: statusLabel(lastState), enabled: false },
    { type: 'separator' },
    { label: 'Abrir painel', click: showWindow },
    { label: 'Iniciar com o Windows', type: 'checkbox', checked: app.getLoginItemSettings().openAtLogin,
      click: i => app.setLoginItemSettings({ openAtLogin: i.checked, args: ['--hidden'] }) },
    { type: 'separator' },
    { label: 'Sair (para os envios por QR Code)', click: () => { quitting = true; app.quit(); } },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Domma Connect Lead — ${statusLabel(lastState)}`);
}

app.whenReady().then(async () => {
  await readToken();
  session.defaultSession.cookies.on('changed', (_e, cookie, _cause, removed) => {
    if (cookie.name === 'cl_token') { token = removed ? null : cookie.value; engine?.kick(); }
  });
  tray = new Tray(ICON.resize({ width: 16, height: 16 }));
  tray.on('click', showWindow);
  buildTray();
  if (!process.argv.includes('--hidden')) createWindow();

  engine = new Engine({
    baseUrl: APP_URL, getToken: () => token, version: app.getVersion(),
    dataDir: path.join(app.getPath('userData'), 'motor'),
    onStatus: s => {
      const changed = statusLabel(s) !== statusLabel(lastState);
      lastState = s;
      if (changed) buildTray();
    },
  });
  engine.start();
});

app.on('window-all-closed', () => { /* continua na bandeja */ });
app.on('before-quit', async e => {
  quitting = true;
  if (engine) { e.preventDefault(); const eg = engine; engine = null; await eg.stop().catch(() => {}); app.quit(); }
});
