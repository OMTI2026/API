import crypto from 'node:crypto';

// Refresh token opaco: se entrega en claro al cliente (cookie httpOnly),
// pero en la base solo guardamos su hash SHA-256.
export function newRefreshToken() {
  const raw = crypto.randomBytes(48).toString('hex');
  return { raw, hash: hashToken(raw) };
}

export function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}
