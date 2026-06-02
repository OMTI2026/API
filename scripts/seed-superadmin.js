// Crea (o actualiza) un super admin que entra DIRECTO por la API:
//   rol 'admin' (rol máximo actual), bu 'ambos', activo,
//   must_change_password = FALSE  -> NO fuerza cambio de contraseña al entrar.
//
// A diferencia de seed-admin.js (que sí fuerza el cambio), este desbloquea el
// login limpio por API para el front en modo 'api'.
//
// Credenciales por env (NO se hardcodean):
//   SUPERADMIN_EMAIL, SUPERADMIN_PASSWORD  (obligatorias)
//   SUPERADMIN_NOMBRE                       (opcional, default 'Super Admin')
//
// Uso (contra el Postgres PÚBLICO del entorno, igual que seed:admin):
//   DATABASE_URL=<public-url> \
//   SUPERADMIN_EMAIL=super@elroi.mx SUPERADMIN_PASSWORD='...' \
//   JWT_ACCESS_SECRET=$(printf 'x%.0s' {1..40}) JWT_REFRESH_SECRET=$(printf 'y%.0s' {1..40}) \
//   npm run seed:superadmin
import { pool } from '../src/db.js';
import { hashPassword } from '../src/lib/argon.js';

const email = process.env.SUPERADMIN_EMAIL;
const password = process.env.SUPERADMIN_PASSWORD;
const nombre = process.env.SUPERADMIN_NOMBRE || 'Super Admin';

if (!email || !password) {
  console.error('❌ Falta SUPERADMIN_EMAIL y/o SUPERADMIN_PASSWORD.');
  process.exit(1);
}

async function main() {
  const hash = await hashPassword(password);
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);

  if (rows[0]) {
    await pool.query(
      `UPDATE users SET pass_hash = $1, nombre = $2, rol = 'admin', bu = 'ambos', activo = true,
       must_change_password = false, failed_logins = 0, locked_until = NULL, updated_at = now()
       WHERE email = $3`,
      [hash, nombre, email],
    );
    console.log(`✅ Super admin actualizado: ${email} (entra directo, sin cambio forzado)`);
  } else {
    await pool.query(
      `INSERT INTO users (nombre, email, pass_hash, rol, bu, activo, must_change_password)
       VALUES ($1, $2, $3, 'admin', 'ambos', true, false)`,
      [nombre, email, hash],
    );
    console.log(`✅ Super admin creado: ${email} (entra directo, sin cambio forzado)`);
  }
  await pool.end();
}

main().catch((err) => {
  console.error('❌ Seed super admin falló:', err);
  process.exit(1);
});
