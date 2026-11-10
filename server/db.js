// Banco Postgres (Supabase). Use `?` nos SQLs: são trocados por $1, $2… automaticamente.
import pg from 'pg';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

pg.types.setTypeParser(20, v => Number(v));   // BIGINT / COUNT(*) → number
pg.types.setTypeParser(1700, v => Number(v)); // NUMERIC (SUM) → number

const url = process.env.DATABASE_URL;
if (!url) throw new Error('Defina DATABASE_URL (string de conexão do Postgres/Supabase)');
const local = /@(localhost|127\.0\.0\.1)|host=\/|@\/|%2F/.test(url) || process.env.DATABASE_SSL === 'off';

export const pool = new pg.Pool({
  connectionString: url,
  ssl: local ? false : { rejectUnauthorized: false },
  max: Number(process.env.DB_POOL_MAX) || (process.env.VERCEL ? 3 : 8),
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 15_000,
});
pool.on('error', e => console.error('Postgres', e.message));

const toPg = sql => { let i = 0; return sql.replace(/\?/g, () => '$' + (++i)); };

function wrapClient(c) {
  return {
    q: (sql, args = []) => c.query(toPg(sql), args),
    all: async (sql, args = []) => (await c.query(toPg(sql), args)).rows,
    get: async (sql, args = []) => (await c.query(toPg(sql), args)).rows[0],
    run: async (sql, args = []) => { const r = await c.query(toPg(sql), args); return { changes: r.rowCount, rows: r.rows }; },
  };
}

export const db = {
  ...wrapClient(pool),
  /** Executa fn dentro de uma transação */
  async tx(fn) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const out = await fn(wrapClient(c));
      await c.query('COMMIT');
      return out;
    } catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
    finally { c.release(); }
  },
};

export async function migrate() {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  await pool.query(fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8'));
}

export const now = () => new Date().toISOString();
export const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
