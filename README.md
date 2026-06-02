# ELROI CargoDesk — API

API Fastify para el TMS: **PostgreSQL (Railway) + Bucket S3-compatible (Railway) + Auth JWT/Argon2**.

> **Infra ya desplegada** (prod + dev) y cómo operarla: ver **[`OPERACIONES.md`](./OPERACIONES.md)**.

## Estructura

```
api/
├── src/
│   ├── server.js            # bootstrap Fastify
│   ├── env.js  db.js         # config + pool pg
│   ├── lib/    argon jwt tokens r2 scope
│   ├── plugins/ auth (JWT)  rbac (rol)
│   └── routes/  health  auth  upload
├── migrations/ 0001_init.sql  migrate.js
└── scripts/    seed-admin.js
```

## Desarrollo local

```bash
cd api
cp .env.example .env          # rellena DATABASE_URL y secrets
npm install
npm run migrate:up            # crea el esquema
npm run seed:admin            # crea admin@elroi.mx (cambio forzado al entrar)
npm run dev                   # http://localhost:3000/health
```

Generar secretos JWT:
```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

## Smoke test (tras desplegar)

Valida login + CRUD + upload contra la API ya desplegada:

```bash
BASE_URL=https://tu-api.up.railway.app \
ADMIN_EMAIL=admin@elroi.mx ADMIN_PASSWORD=elroi2025 \
npm run smoke
```

## Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| GET  | `/health` `/health/db` | liveness / readiness |
| POST | `/auth/login` | email+password (+totp si 2FA) → accessToken + cookie refresh |
| POST | `/auth/refresh` | rota refresh (cookie) → nuevo accessToken |
| POST | `/auth/logout` | revoca refresh |
| GET  | `/auth/me` | perfil del usuario autenticado |
| POST | `/auth/change-password` | cambia contraseña (cierra sesiones) |
| POST | `/auth/2fa/setup` `/auth/2fa/verify` | alta de TOTP |
| POST | `/upload/sign` | URL PUT firmada para subir al bucket |
| POST | `/upload/confirm` | registra metadata en `archivos` |
| GET  | `/upload/:id/url` | URL GET firmada para mostrar |
| GET  | `/upload/by-flete/:fleteId` | lista archivos de un flete |

---

## Provisión e infraestructura

Ya está **desplegado en Railway** (proyecto `worthy-hope`), en dos entornos (`production` y `development`), cada uno con su Postgres, su bucket S3-compatible y la API. El almacenamiento usa **buckets nativos de Railway** (no Cloudflare R2; el código es S3-compatible y funciona igual).

👉 Para provisión desde cero, redeploy, migraciones, seed, logs, URLs y troubleshooting: **[`OPERACIONES.md`](./OPERACIONES.md)**.

## Notas de seguridad

- Secretos JWT distintos por entorno; nunca en git (`.env` ignorado).
- En producción `CORS_ORIGIN` debe ser el dominio del front, no `*`.
- Refresh en cookie `httpOnly/Secure/SameSite=Strict`, con rotación y revocación.
- Rate-limit global + reforzado en `/auth/login`; lockout tras 5 intentos (15 min).
