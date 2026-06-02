import fp from 'fastify-plugin';

// Decora la app con `requireRole(...roles)` para usar como preHandler
// después de `authenticate`.
export default fp(async function rbacPlugin(app) {
  app.decorate('requireRole', function (...roles) {
    return async function (req, reply) {
      if (!req.user) return reply.code(401).send({ error: 'unauthenticated' });
      if (!roles.includes(req.user.rol)) {
        return reply.code(403).send({ error: 'forbidden', need: roles });
      }
    };
  });
});
