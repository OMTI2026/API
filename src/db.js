import pg from 'pg';
import { databaseUrl } from './env.js';

// SSL: las conexiones públicas de Railway lo requieren; las internas
// (postgres.railway.internal) y locales NO usan SSL.
const noSsl = /@(localhost|127\.0\.0\.1)/.test(databaseUrl) || /\.railway\.internal/.test(databaseUrl);

export const pool = new pg.Pool({
  connectionString: databaseUrl,
  ssl: noSsl ? false : { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30_000,
});

export const q = (text, params) => pool.query(text, params);

export async function withTx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
