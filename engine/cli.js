// Motor de envio pela linha de comando (para testes e servidores):
//   ENGINE_URL=http://localhost:3000 ENGINE_EMAIL=... ENGINE_PASSWORD=... npm run engine
import path from 'node:path';
import { Engine } from './engine.js';

const baseUrl = process.env.ENGINE_URL || 'http://localhost:3000';
const r = await fetch(baseUrl + '/api/engine/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: process.env.ENGINE_EMAIL, password: process.env.ENGINE_PASSWORD }) });
const j = await r.json();
if (!r.ok) { console.error('Login falhou:', j.error); process.exit(1); }
let last = '';
const eng = new Engine({
  baseUrl, getToken: () => j.token, dataDir: process.env.ENGINE_DATA_DIR || path.resolve('data', 'engine'),
  onStatus: s => { const t = JSON.stringify({ online: s.online, error: s.error, conns: s.connections.map(c => `${c.id}:${c.status}`), sent: s.sent }); if (t !== last) console.log(new Date().toLocaleTimeString('pt-BR'), t); last = t; },
});
eng.start();
console.log(`Motor de envio ligado em ${baseUrl} (id ${eng.id})`);
