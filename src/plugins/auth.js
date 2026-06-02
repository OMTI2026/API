import fp from 'fastify-plugin';
import { verifyAccess } from '../lib/jwt.js';

// Decora la app con `authenticate`: valida el access token JWT (Bearer)
// y deja el usuario en req.user.
export default fp(async function authPlugin(app) {
  app.decorateRequest('user', null);

  app.decorate('authenticate', async function (req, reply) {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return reply.code(401).send({ error: 'no_token' });

    try {
      const payload = verifyAccess(token);
      req.user = { id: payload.sub, rol: payload.rol, bu: payload.bu, name: payload.name };
    } catch {
      return reply.code(401).send({ error: 'invalid_token' });
    }
  });
});
