// Segredos para rodar localmente sem configurar nada. Em produção (Vercel), use as variáveis de ambiente.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export function localSecret(name, bytes) {
  if (process.env.VERCEL) throw new Error(`Configure a variável de ambiente para ${name} na Vercel`);
  const dir = process.env.DATA_DIR || path.resolve('data');
  fs.mkdirSync(dir, { recursive: true });
  const f = path.join(dir, name);
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
  const s = crypto.randomBytes(bytes).toString('hex');
  fs.writeFileSync(f, s);
  return s;
}
