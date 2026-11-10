// Cria/atualiza as tabelas no Postgres apontado por DATABASE_URL
import { migrate, pool } from '../server/db.js';
await migrate();
await pool.end();
console.log('Banco atualizado ✅');
