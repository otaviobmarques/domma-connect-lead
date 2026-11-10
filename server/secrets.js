// Segredos do servidor (sessões e criptografia das chaves de IA).
// Ordem: variável de ambiente → tabela app_secrets no banco (gerado na primeira execução).
import crypto from 'node:crypto';
import { db } from './db.js';

export const SECRETS = { jwt: null, enc: null };
let loading = null;

async function fromDb(name, bytes) {
  await db.run('CREATE TABLE IF NOT EXISTS app_secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL)');
  await db.run('INSERT INTO app_secrets (name, value) VALUES (?, ?) ON CONFLICT (name) DO NOTHING', [name, crypto.randomBytes(bytes).toString('hex')]);
  return (await db.get('SELECT value FROM app_secrets WHERE name=?', [name])).value;
}

export function loadSecrets() {
  return loading ||= (async () => {
    SECRETS.jwt = process.env.JWT_SECRET || await fromDb('jwt', 48);
    SECRETS.enc = crypto.createHash('sha256').update(process.env.ENCRYPTION_KEY || await fromDb('enc', 32)).digest();
  })().catch(e => { loading = null; throw e; });
}
