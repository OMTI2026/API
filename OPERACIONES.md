# Operaciones — ELROI CargoDesk API (Railway)

Runbook para operar el backend ya desplegado. Si retomas en una **sesión nueva**, empieza por aquí.

---

## 1. Qué hay desplegado

Proyecto Railway **`worthy-hope`** (`6bbb22fc-a939-446e-b80b-c63fe1efd8c2`), workspace *omti2026's Projects*. CLI autenticado como `omar.torres@t-elroi.com`. Dos entornos **aislados** (base y bucket propios):

| Recurso | production | development |
|---|---|---|
| **API (Fastify)** | https://api-production-5bab4.up.railway.app | https://api-development-3a6e.up.railway.app |
| **Postgres** (servicio) | `Postgres` | `Postgres-BRH8` |
| **Bucket** (S3 · `t3.storageapi.dev`) | `tms-evidencias` | `tms-evidencias-dev` |
| **Frontend** (estático Caddy, servicio `TMS`) | `tms.t-elroicargodesk.com` | — |

- **Login admin** (ambas bases): `admin@elroi.mx` / `elroi2025` → fuerza cambio de contraseña al primer login.
- **Verificación:** `npm run smoke` pasa 12/12 contra ambos entornos.
- **Secrets** (JWT, R2, DB) viven en variables de Railway por entorno. **Nada de eso está en el repo.**

### Arquitectura (recordatorio)
```
Navegador → TMS (index.html estático)  → fetch → API (Fastify) → Postgres
                                                              → Bucket (S3)
```
`TMS` = frontend (lo que ve el usuario). `api` = backend (DB, archivos, auth). Hoy el TMS aún usa `localStorage`; falta cablearlo a la API (paso H6, ver §7).

---

## 2. Prerrequisitos de la terminal

```bash
# Node v26 está en Homebrew pero puede no estar en el PATH del shell:
export PATH="/opt/homebrew/bin:$PATH"
railway whoami     # debe decir omar.torres@t-elroi.com
```

Linkear el proyecto/entorno en el que vas a trabajar:
```bash
railway link --project 6bbb22fc-a939-446e-b80b-c63fe1efd8c2 --environment production
# o cambiar de entorno:
railway environment development      # o: railway environment production
```

> ⚠️ La API de Railway (`backboard.railway.com/graphql`) da **timeouts intermitentes**. Si un comando falla con *"Failed to fetch / operation timed out"*, **reintenta** (suele pasar al 2º o 3er intento).

---

## 3. Redeploy de la API (tras cambiar código)

Desde la **raíz del repo** (la que contiene `api/` e `index.html`):

```bash
export PATH="/opt/homebrew/bin:$PATH"
railway up ./api --path-as-root -s api -e production --ci   # o -e development
```

🔴 **`--path-as-root` es obligatorio.** Sin él, `railway up` empaqueta la raíz del repo (que tiene `index.html`) y railpack construye un **sitio estático Caddy** en vez del servicio Node → el síntoma es `/health` devolviendo 200 con cuerpo vacío y `/health/db` un 404. Con `--path-as-root` el archivo se enraíza en `api/`, se detecta Node y se respeta `railway.json`.

Las **migraciones corren solas al arrancar** (`startCommand` en `api/railway.json` = `npm run migrate:up && npm start`).

Verificar tras el deploy:
```bash
curl -s https://api-production-5bab4.up.railway.app/health/db   # {"db":true,"r2":true}
```

---

## 4. Migraciones de base de datos

- Los archivos viven en `api/migrations/NNNN_*.sql` (numerados, en orden). El runner es `api/migrations/migrate.js` y registra lo aplicado en la tabla `_migrations`.
- **Agregar una migración:** crea `api/migrations/0002_descripcion.sql` con SQL idempotente. Se aplicará sola en el siguiente deploy (o manualmente, abajo).
- **Aplicar manualmente** contra un entorno (usa la URL **pública** del Postgres del entorno):

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd api
# PROD usa servicio "Postgres"; DEV usa "Postgres-BRH8"
PUB=$(railway variables -s Postgres -e production --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).DATABASE_PUBLIC_URL))")
DATABASE_URL="$PUB" JWT_ACCESS_SECRET=$(printf 'x%.0s' {1..40}) JWT_REFRESH_SECRET=$(printf 'y%.0s' {1..40}) npm run migrate:up
```

---

## 5. Seed del admin / reset

```bash
cd api
PUB=$(railway variables -s Postgres -e production --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).DATABASE_PUBLIC_URL))")
DATABASE_URL="$PUB" NODE_ENV=development \
  JWT_ACCESS_SECRET=$(printf 'x%.0s' {1..40}) JWT_REFRESH_SECRET=$(printf 'y%.0s' {1..40}) \
  SEED_ADMIN_EMAIL=admin@elroi.mx SEED_ADMIN_PASSWORD=elroi2025 npm run seed:admin
```

(Para dev, cambia `-s Postgres` → `-s Postgres-BRH8` y `-e production` → `-e development`.)

### Super admin que entra directo (sin cambio forzado)

A diferencia de `seed:admin` (que fuerza cambio de contraseña), `seed:superadmin` crea
un usuario rol `admin` con `must_change_password=false` → entra directo por la API
(desbloquea el login del front en modo `api`). Credenciales por env (no se hardcodean):

```bash
cd api
PUB=$(railway variables -s Postgres -e production --json | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).DATABASE_PUBLIC_URL))")
DATABASE_URL="$PUB" \
  SUPERADMIN_EMAIL=super@elroi.mx SUPERADMIN_PASSWORD='<contraseña-fuerte>' \
  JWT_ACCESS_SECRET=$(printf 'x%.0s' {1..40}) JWT_REFRESH_SECRET=$(printf 'y%.0s' {1..40}) \
  npm run seed:superadmin
```

(Dev: `-s Postgres-BRH8` y `-e development`.) Es idempotente: si el email ya existe, lo actualiza.

---

## 6. Variables, logs y diagnóstico

```bash
export PATH="/opt/homebrew/bin:$PATH"
# Ver claves (sin valores): pipe | sed 's/=.*/=<set>/'
railway variables -s api -e production --kv

# Setear (no imprimir secretos en pantalla):
railway variables -s api -e production --skip-deploys --set "CORS_ORIGIN=https://tms.t-elroicargodesk.com"

# Logs del servicio:
railway logs -s api -e production

# Estado/dominios:
railway status --json
railway domain -s api -e production --json     # genera/lee el dominio público
```

**Credenciales del bucket** (S3): `railway bucket credentials --bucket tms-evidencias -e production --json`. Variables S3 esperadas por la API: `R2_ENDPOINT`, `R2_BUCKET`, `R2_KEY`, `R2_SECRET`.

### Smoke test end-to-end
```bash
cd api
BASE_URL=https://api-production-5bab4.up.railway.app \
ADMIN_EMAIL=admin@elroi.mx ADMIN_PASSWORD=elroi2025 npm run smoke
```

---

## 7. Cómo continuar (próximos pasos)

1. **H6 — cablear el frontend a la API.** El `index.html` aún usa `localStorage`. Hay que reemplazar `saveAll/loadAll`, `gFl/gCxC/gCxP`, `autenticarUsuario()` y los flujos de archivos por llamadas a **`ElroiAPI`** (`api-client.js`, en la raíz del repo). Apuntar con:
   ```js
   ElroiAPI.config({ baseUrl: 'https://api-production-5bab4.up.railway.app' });
   ```
   Migrar módulo por módulo (auth primero, luego fletes, CxC/CxP). Mantener ES5 estricto (sin arrow, sin template literals).
2. **Conectar el deploy a GitHub** (hoy es `railway up` manual; un push no redespliega). Implica configurar el servicio `api` con source = repo y **Root Directory = `api`**.
3. **Migrar datos reales** del `localStorage` actual a Postgres (script one-off) si ya hay fletes/clientes en uso.
4. **Endurecer:** mover validación de secuencias CxC/CxP y monitoreo al servidor; flujo de "olvidé contraseña"; activar 2FA al admin.

> El código de la API vive en este repo (origin: `OMTI2026/API`). El detalle del diseño y el plan de migración están en el repo del frontend: [`OMTI2026/TMS` · `MIGRACION.md`](https://github.com/OMTI2026/TMS/blob/main/MIGRACION.md).

---

## 8. Troubleshooting rápido

| Síntoma | Causa / fix |
|---|---|
| `/health` 200 vacío, `/health/db` 404 | Se desplegó como sitio estático Caddy. Re-deploy con **`--path-as-root`** (§3). |
| `Failed to fetch / operation timed out` en `railway …` | Timeout intermitente de Railway. **Reintenta**. |
| `/health/db` → `{"db":false}` | La API no conecta a Postgres. Revisa `DATABASE_URL` (debe referenciar `${{Postgres.DATABASE_URL}}` en prod / `${{Postgres-BRH8.DATABASE_URL}}` en dev). |
| `r2:false` en `/health/db` | Faltan `R2_*` o el bucket no expone credenciales aún (espera ~30s tras crearlo y reintenta). |
| Error SSL al conectar a Postgres | Conexión interna `*.railway.internal` no usa SSL (ya manejado en `src/db.js`). Para conexiones externas se usa la URL **pública** con SSL. |
