import { z } from 'zod';
import { authenticator } from 'otplib';
import { q, withTx } from '../db.js';
import { env } from '../env.js';
import { hashPassword, verifyPassword } from '../lib/argon.js';
import { signAccess } from '../lib/jwt.js';
import { newRefreshToken, hashToken } from '../lib/tokens.js';
import { effectivePerms } from '../lib/permissions.js';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const REFRESH_COOKIE = 'elroi_rt';

function refreshCookieOpts() {
  return {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
    path: '/auth',
    maxAge: env.REFRESH_TTL_DAYS * 24 * 60 * 60,
  };
}

function publicUser(u) {
  return { id: u.id, nombre: u.nombre, email: u.email, rol: u.rol, bu: u.bu, permissions: effectivePerms(u) };
}

async function issueRefresh(userId, userAgent) {
  const { raw, hash } = newRefreshToken();
  const expires = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
  await q(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent)
     VALUES ($1, $2, $3, $4)`,
    [userId, hash, expires, userAgent || null],
  );
  return raw;
}

export default async function authRoutes(app) {
  const loginSchema = z.object({
    email: z.string().email(),
    password: z.string().min(1),
    totp: z.string().optional(),
  });

  // ── LOGIN ──────────────────────────────────────────────
  app.post('/login', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const { email, password, totp } = parsed.data;

    const { rows } = await q('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];

    // Respuesta genérica para no filtrar existencia de cuentas.
    const invalid = () => reply.code(401).send({ error: 'invalid_credentials' });
    if (!user || !user.activo) return invalid();

    if (user.locked_until && new Date(user.locked_until) > new Date()) {
      return reply.code(423).send({ error: 'account_locked', until: user.locked_until });
    }

    const ok = await verifyPassword(user.pass_hash, password);
    if (!ok) {
      const failed = user.failed_logins + 1;
      const lock = failed >= MAX_FAILED ? new Date(Date.now() + LOCK_MINUTES * 60_000) : null;
      await q('UPDATE users SET failed_logins = $1, locked_until = $2 WHERE id = $3', [failed, lock, user.id]);
      return invalid();
    }

    // 2FA obligatorio si el usuario lo tiene activado.
    if (user.totp_secret) {
      if (!totp) return reply.code(401).send({ error: 'totp_required' });
      if (!authenticator.verify({ token: totp, secret: user.totp_secret })) {
        return reply.code(401).send({ error: 'totp_invalid' });
      }
    }

    await q('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [user.id]);

    const accessToken = signAccess(user);
    const raw = await issueRefresh(user.id, req.headers['user-agent']);
    reply.setCookie(REFRESH_COOKIE, raw, refreshCookieOpts());

    return {
      accessToken,
      user: publicUser(user),
      mustChangePassword: user.must_change_password,
    };
  });

  // ── REFRESH (rotación + detección de reuse) ────────────
  // Bucket de rate limit propio (independiente del global de 100/min por IP):
  // el refresh silencioso al recargar no debe quedar starve-ado por la ráfaga de
  // llamadas de datos de una página pesada (p. ej. Cobranza). Sin esto, una
  // recarga que satura el límite global hacía que /auth/refresh devolviera 429 y
  // el cliente cerrara la sesión. 60/min/IP es holgado para refrescos legítimos.
  app.post('/refresh', {
    config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (!raw) return reply.code(401).send({ error: 'no_refresh' });
    const tokenHash = hashToken(raw);

    try {
      const result = await withTx(async (client) => {
        const { rows } = await client.query(
          'SELECT * FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE',
          [tokenHash],
        );
        const rt = rows[0];
        if (!rt) return { error: 'invalid_refresh' };

        // Reuse de un token ya revocado → posible robo: revoca toda la sesión del usuario.
        if (rt.revoked_at) {
          await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [rt.user_id]);
          return { error: 'refresh_reused' };
        }
        if (new Date(rt.expires_at) < new Date()) return { error: 'refresh_expired' };

        await client.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [rt.id]);

        const { rows: urows } = await client.query('SELECT * FROM users WHERE id = $1', [rt.user_id]);
        const user = urows[0];
        if (!user || !user.activo) return { error: 'user_inactive' };

        const { raw: newRaw, hash } = newRefreshToken();
        const expires = new Date(Date.now() + env.REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000);
        await client.query(
          'INSERT INTO refresh_tokens (user_id, token_hash, expires_at, user_agent) VALUES ($1,$2,$3,$4)',
          [user.id, hash, expires, req.headers['user-agent'] || null],
        );
        return { user, newRaw };
      });

      if (result.error) return reply.code(401).send({ error: result.error });

      reply.setCookie(REFRESH_COOKIE, result.newRaw, refreshCookieOpts());
      return { accessToken: signAccess(result.user), user: publicUser(result.user) };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: 'refresh_failed' });
    }
  });

  // ── LOGOUT ─────────────────────────────────────────────
  app.post('/logout', async (req, reply) => {
    const raw = req.cookies?.[REFRESH_COOKIE];
    if (raw) await q('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL', [hashToken(raw)]);
    reply.clearCookie(REFRESH_COOKIE, { path: '/auth' });
    return { ok: true };
  });

  // ── ME ─────────────────────────────────────────────────
  app.get('/me', { preHandler: [app.authenticate] }, async (req) => {
    const { rows } = await q('SELECT id, nombre, email, rol, bu, permissions, must_change_password, totp_secret IS NOT NULL AS has_2fa FROM users WHERE id = $1', [req.user.id]);
    const u = rows[0];
    if (!u) return null;
    return { ...u, permissions: effectivePerms(u) };
  });

  // ── CAMBIO DE CONTRASEÑA ───────────────────────────────
  const changeSchema = z.object({ current: z.string().min(1), next: z.string().min(8) });
  app.post('/change-password', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = changeSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });

    const { rows } = await q('SELECT pass_hash FROM users WHERE id = $1', [req.user.id]);
    if (!rows[0] || !(await verifyPassword(rows[0].pass_hash, parsed.data.current))) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    const hash = await hashPassword(parsed.data.next);
    await q('UPDATE users SET pass_hash = $1, must_change_password = false, updated_at = now() WHERE id = $2', [hash, req.user.id]);
    // Cierra todas las sesiones previas por seguridad.
    await q('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
    return { ok: true };
  });

  // ── 2FA (TOTP) ─────────────────────────────────────────
  app.post('/2fa/setup', { preHandler: [app.authenticate] }, async (req) => {
    const secret = authenticator.generateSecret();
    const otpauth = authenticator.keyuri(req.user.name || req.user.id, 'ELROI CargoDesk', secret);
    // Se guarda como "pendiente" hasta que /2fa/verify confirme con un código válido.
    await q('UPDATE users SET totp_pending = $1 WHERE id = $2', [secret, req.user.id]);
    return { secret, otpauth };
  });

  const verifySchema = z.object({ token: z.string().min(6) });
  app.post('/2fa/verify', { preHandler: [app.authenticate] }, async (req, reply) => {
    const parsed = verifySchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'bad_request' });
    const { rows } = await q('SELECT totp_pending FROM users WHERE id = $1', [req.user.id]);
    const secret = rows[0]?.totp_pending;
    if (!secret) return reply.code(400).send({ error: 'no_pending_2fa' });
    if (!authenticator.verify({ token: parsed.data.token, secret })) {
      return reply.code(401).send({ error: 'totp_invalid' });
    }
    await q('UPDATE users SET totp_secret = $1, totp_pending = NULL WHERE id = $2', [secret, req.user.id]);
    return { ok: true };
  });
}
