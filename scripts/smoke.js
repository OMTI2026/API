// Smoke test end-to-end contra la API desplegada.
// No usa dependencias (fetch nativo de Node 18+).
//
//   BASE_URL=https://tu-api.up.railway.app \
//   ADMIN_EMAIL=admin@elroi.mx ADMIN_PASSWORD=elroi2025 \
//   node scripts/smoke.js
//
// Requiere haber corrido migrate:up y seed:admin en esa base.

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.env.ADMIN_EMAIL || 'admin@elroi.mx';
const PASSWORD = process.env.ADMIN_PASSWORD || 'elroi2025';

let token = null;
let pass = 0;
let fail = 0;

function log(ok, name, extra) {
  if (ok) { pass++; console.log(`  ✅ ${name}${extra ? ' — ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

async function call(method, path, body, useAuth) {
  const headers = { Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (useAuth && token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* sin cuerpo */ }
  return { status: res.status, data };
}

async function main() {
  console.log(`\n🔎 Smoke test → ${BASE}\n`);

  // 1) Health
  const h = await call('GET', '/health');
  log(h.status === 200 && h.data && h.data.ok, 'GET /health', 'status ' + h.status);

  const hdb = await call('GET', '/health/db');
  log(hdb.status === 200 && hdb.data && hdb.data.db === true, 'GET /health/db', 'r2=' + (hdb.data && hdb.data.r2));

  // 2) Login (seed admin)
  const login = await call('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  const okLogin = login.status === 200 && login.data && login.data.accessToken;
  log(okLogin, 'POST /auth/login', okLogin ? 'mustChangePassword=' + login.data.mustChangePassword : 'status ' + login.status);
  if (!okLogin) return finish();
  token = login.data.accessToken;

  // 3) /auth/me
  const me = await call('GET', '/auth/me', null, true);
  log(me.status === 200 && me.data && me.data.email, 'GET /auth/me', me.data && me.data.rol);

  // 4) Crear cliente
  const cli = await call('POST', '/clients', { bu: 'broker', empresa: 'SMOKE TEST SA', rfc: 'XAXX010101000' }, true);
  log(cli.status === 200 && cli.data && cli.data.id, 'POST /clients');
  const clienteId = cli.data && cli.data.id;

  // 5) Crear carrier
  const car = await call('POST', '/carriers', { bu: 'broker', nombre: 'Transportista Smoke' }, true);
  log(car.status === 200 && car.data && car.data.id, 'POST /carriers');

  // 6) Crear flete (auto-genera cxc/cxp)
  const flete = await call('POST', '/fletes', {
    bu: 'broker', folio: 'SMOKE-001', cliente_id: clienteId,
    origen: 'CDMX', destino: 'MTY', tarifa_cobro: 20000, tarifa_pago: 14000,
  }, true);
  const okFlete = flete.status === 201 && flete.data && flete.data.id;
  log(okFlete, 'POST /fletes (201 + auto cxc/cxp)');
  const fleteId = flete.data && flete.data.id;

  // 7) Detalle del flete con cxc/cxp anidados
  if (fleteId) {
    const det = await call('GET', '/fletes/' + fleteId, null, true);
    const okDet = det.status === 200 && det.data.cxc && det.data.cxp;
    log(okDet, 'GET /fletes/:id', okDet ? 'cxc=' + det.data.cxc.status + ' cxp=' + det.data.cxp.status : '');
  }

  // 8) Lista de fletes
  const lst = await call('GET', '/fletes', null, true);
  log(lst.status === 200 && Array.isArray(lst.data), 'GET /fletes', 'n=' + (Array.isArray(lst.data) ? lst.data.length : '?'));

  // 9) Dashboard
  const dash = await call('GET', '/stats/dashboard', null, true);
  log(dash.status === 200 && dash.data, 'GET /stats/dashboard', dash.data && ('venta_anual=' + dash.data.venta_anual));

  // 10) Upload sign (solo si R2 está configurado)
  if (fleteId) {
    const sign = await call('POST', '/upload/sign', {
      fleteId, contexto: 'factura', modulo: 'cxc',
      filename: 'prueba.pdf', mime: 'application/pdf', bytes: 1024,
    }, true);
    if (sign.status === 200 && sign.data && sign.data.url) log(true, 'POST /upload/sign', 'R2 OK');
    else if (sign.status === 503) log(true, 'POST /upload/sign', 'R2 no configurado (esperado si no hay R2_*)');
    else log(false, 'POST /upload/sign', 'status ' + sign.status);
  }

  // 11) Limpieza del flete de prueba
  if (fleteId) {
    const can = await call('POST', '/fletes/' + fleteId + '/cancelar', { motivo: 'smoke', responsable: 'script' }, true);
    log(can.status === 200, 'POST /fletes/:id/cancelar (limpieza)');
  }

  finish();
}

function finish() {
  console.log(`\n${fail === 0 ? '✅' : '❌'} Resultado: ${pass} ok, ${fail} fallos\n`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('💥 Error inesperado:', err.message);
  process.exit(1);
});
