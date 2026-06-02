// Crea (o reactiva) el usuario admin inicial con hash Argon2id.
// Fuerza cambio de contraseña en el primer login.
//   SEED_ADMIN_EMAIL / SEED_ADMIN_PASSWORD configurables por env.
import { pool } from '../src/db.js';
import { hashPassword } from '../src/lib/argon.js';

const email = process.env.SEED_ADMIN_EMAIL || 'admin@elroi.mx';
const password = process.env.SEED_ADMIN_PASSWORD || 'elroi2025';

async function main() {
  const hash = await hashPassword(password);
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);

  if (rows[0]) {
    await pool.query(
      `UPDATE users SET pass_hash = $1, rol = 'admin', bu = 'ambos', activo = true,
       must_change_password = true, failed_logins = 0, locked_until = NULL, updated_at = now()
       WHERE email = $2`,
      [hash, email],
    );
    console.log(`✅ Admin actualizado: ${email} (debe cambiar contraseña al entrar)`);
  } else {
    await pool.query(
      `INSERT INTO users (nombre, email, pass_hash, rol, bu, activo, must_change_password)
       VALUES ('Administrador', $1, $2, 'admin', 'ambos', true, true)`,
      [email, hash],
    );
    console.log(`✅ Admin creado: ${email} (debe cambiar contraseña al entrar)`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error('❌ Seed falló:', err);
  process.exit(1);
});
