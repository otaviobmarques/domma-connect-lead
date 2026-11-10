// Arquivos guardados no banco, em pedaços (a Vercel limita cada requisição a 4,5 MB)
import crypto from 'node:crypto';
import path from 'node:path';
import { db } from './db.js';

export const CHUNK = 3 * 1024 * 1024;
export const MAX_MEDIA = 16 * 1024 * 1024;
export const MAX_SHEET = 20 * 1024 * 1024;

export async function createFile(ws, { name, mime, size, temp }) {
  const max = temp ? MAX_SHEET : MAX_MEDIA;
  size = Number(size) || 0;
  if (size <= 0) throw Object.assign(new Error('Arquivo vazio'), { status: 400 });
  if (size > max) throw Object.assign(new Error(`Arquivo muito grande (máximo ${Math.round(max / 1048576)} MB)`), { status: 400 });
  const id = crypto.randomBytes(12).toString('hex') + path.extname(String(name || '')).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
  await db.run('INSERT INTO files (id, workspace_id, name, mime, size, chunks, temp) VALUES (?,?,?,?,?,?,?)',
    [id, ws, String(name || 'arquivo').slice(0, 200), String(mime || 'application/octet-stream').slice(0, 120), size, Math.ceil(size / CHUNK), !!temp]);
  // limpeza oportunista de planilhas abandonadas
  db.run("DELETE FROM files WHERE temp AND created_at < ?", [new Date(Date.now() - 864e5).toISOString()]).catch(() => {});
  return { id, chunk_size: CHUNK, chunks: Math.ceil(size / CHUNK) };
}

export async function putChunk(ws, id, idx, buf) {
  const f = await db.get('SELECT * FROM files WHERE id=? AND workspace_id=?', [id, ws]);
  if (!f) throw Object.assign(new Error('Arquivo não encontrado'), { status: 404 });
  if (f.complete) throw Object.assign(new Error('Arquivo já finalizado'), { status: 400 });
  if (!(idx >= 0 && idx < f.chunks) || buf.length > CHUNK) throw Object.assign(new Error('Pedaço inválido'), { status: 400 });
  await db.run('INSERT INTO file_chunks (file_id, idx, data) VALUES (?,?,?) ON CONFLICT (file_id, idx) DO UPDATE SET data=EXCLUDED.data', [id, idx, buf]);
}

export async function completeFile(ws, id) {
  const f = await db.get('SELECT * FROM files WHERE id=? AND workspace_id=?', [id, ws]);
  if (!f) throw Object.assign(new Error('Arquivo não encontrado'), { status: 404 });
  const r = await db.get('SELECT COUNT(*) n, COALESCE(SUM(length(data)),0) bytes FROM file_chunks WHERE file_id=?', [id]);
  if (r.n !== f.chunks || r.bytes !== f.size) throw Object.assign(new Error('O envio do arquivo ficou incompleto. Tente de novo.'), { status: 400 });
  await db.run('UPDATE files SET complete=true WHERE id=?', [id]);
  return { file: f.id, mime: f.mime, name: f.name, size: f.size };
}

export const fileInfo = (id, ws) => ws == null
  ? db.get('SELECT * FROM files WHERE id=? AND complete', [id])
  : db.get('SELECT * FROM files WHERE id=? AND workspace_id=? AND complete', [id, ws]);

export async function readFile(id) {
  const rows = await db.all('SELECT data FROM file_chunks WHERE file_id=? ORDER BY idx', [id]);
  return Buffer.concat(rows.map(r => r.data));
}
export async function readChunk(id, idx) {
  return (await db.get('SELECT data FROM file_chunks WHERE file_id=? AND idx=?', [id, idx]))?.data || null;
}
export const deleteFile = id => db.run('DELETE FROM files WHERE id=?', [id]);
