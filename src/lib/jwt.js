import jwt from 'jsonwebtoken';
import { env } from '../env.js';

export function signAccess(user) {
  return jwt.sign(
    { rol: user.rol, bu: user.bu, name: user.nombre },
    env.JWT_ACCESS_SECRET,
    { subject: String(user.id), expiresIn: env.ACCESS_TTL },
  );
}

export function verifyAccess(token) {
  return jwt.verify(token, env.JWT_ACCESS_SECRET);
}
