// Runner de migraciones SQL minimalista (sin dependencias externas).
// Aplica en orden los archivos NNNN_*.sql de esta carpeta dentro de una transacción
// y registra los aplicados en la tabla _migrations.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function ensureTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name        TEXT PRIMARY KEY,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
}

async function appliedSet(client) {
  const { rows } = await client.query('SELECT name FROM _migrations');
  return new Set(rows.map((r) => r.name));
}

async function listMigrations() {
  const files = await readdir(__dirname);
  return files.filter((f) => /^\d+.*\.sql$/.test(f)).sort();
}

async function up() {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await appliedSet(client);
    const all = await listMigrations();
    const pending = all.filter((f) => !done.has(f));

    if (pending.length === 0) {
      console.log('✅ Sin migraciones pendientes.');
      return;
    }
    for (const file of pending) {
      const sql = await readFile(join(__dirname, file), 'utf8');
      console.log(`▶ Aplicando ${file} ...`);
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO _migrations (name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        console.log(`✅ ${file}`);
      } catch (err) {
        await client.query('ROLLBACK');
        console.error(`❌ Falló ${file}:`, err.message);
        throw err;
      }
    }
  } finally {
    client.release();
    await pool.end();
  }
}

async function status() {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = await appliedSet(client);
    const all = await listMigrations();
    for (const f of all) console.log(`${done.has(f) ? '✔' : '·'} ${f}`);
  } finally {
    client.release();
    await pool.end();
  }
}

const cmd = process.argv[2] || 'up';
const fn = { up, status }[cmd];
if (!fn) {
  console.error('Uso: node migrations/migrate.js [up|status]');
  process.exit(1);
}
fn().catch((err) => {
  console.error(err);
  process.exit(1);
});
