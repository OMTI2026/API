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

  // 8b) Listas en bloque que Cobranza/Pagos usan para armar la tabla sin N+1.
  const cxpL = await call('GET', '/cxp', null, true);
  log(cxpL.status === 200 && Array.isArray(cxpL.data), 'GET /cxp (lista)', 'n=' + (Array.isArray(cxpL.data) ? cxpL.data.length : '?'));
  const cxcL = await call('GET', '/cxc', null, true);
  log(cxcL.status === 200 && Array.isArray(cxcL.data), 'GET /cxc (lista)', 'n=' + (Array.isArray(cxcL.data) ? cxcL.data.length : '?'));
  const gL = await call('GET', '/gastos', null, true);
  log(gL.status === 200 && Array.isArray(gL.data), 'GET /gastos (lista)', 'n=' + (Array.isArray(gL.data) ? gL.data.length : '?'));
  const ccL = await call('GET', '/casetas-cargas', null, true);
  log(ccL.status === 200 && Array.isArray(ccL.data), 'GET /casetas-cargas (lista)', 'n=' + (Array.isArray(ccL.data) ? ccL.data.length : '?'));
  const cpL = await call('GET', '/casetas-pagos', null, true);
  log(cpL.status === 200 && Array.isArray(cpL.data), 'GET /casetas-pagos (lista)', 'n=' + (Array.isArray(cpL.data) ? cpL.data.length : '?'));

  // 9) Dashboard
  const dash = await call('GET', '/stats/dashboard', null, true);
  const okDash = dash.status === 200 && dash.data
    && dash.data.proy_util_anual !== undefined && dash.data.proy_util_mes !== undefined;
  log(okDash, 'GET /stats/dashboard (+util proy)', dash.data && ('venta_anual=' + dash.data.venta_anual + ' proy_util_anual=' + dash.data.proy_util_anual));

  // 9a) Proyección mensual (alimenta la gráfica venta/utilidad proyectada).
  const proy = await call('GET', '/stats/proyeccion-mensual', null, true);
  log(proy.status === 200 && Array.isArray(proy.data), 'GET /stats/proyeccion-mensual', 'n=' + (Array.isArray(proy.data) ? proy.data.length : '?'));

  // 9b) Gastos operativos: alta (sin viaje) + lista. Limpieza al final.
  let gastoOpId = null;
  const goCreate = await call('POST', '/gastos-operativos', {
    bu: 'broker', concepto: 'Gasolina smoke', monto: 500, categoria: 'Combustible', metodo_pago: 'Efectivo',
  }, true);
  log(goCreate.status === 200 && goCreate.data && goCreate.data.id, 'POST /gastos-operativos (sin viaje)');
  if (goCreate.data && goCreate.data.id) gastoOpId = goCreate.data.id;
  const goList = await call('GET', '/gastos-operativos', null, true);
  log(goList.status === 200 && Array.isArray(goList.data), 'GET /gastos-operativos', 'n=' + (Array.isArray(goList.data) ? goList.data.length : '?'));

  // 9c) Mantenimiento: alta asigna Folio OT autogenerado (OT\d+). Limpieza al final.
  let mantId = null;
  const mantCreate = await call('POST', '/mantenimientos', {
    bu: 'broker', checklist_id: 'smoke-test', referencia: 'SMOKE-1',
  }, true);
  const folioOk = mantCreate.status === 200 && mantCreate.data && /^OT\d+$/.test(mantCreate.data.data?.folioOt || '');
  log(folioOk, 'POST /mantenimientos (Folio OT auto)', mantCreate.data?.data?.folioOt);
  if (mantCreate.data && mantCreate.data.id) mantId = mantCreate.data.id;

  // 9d) Cotización: alta + lista. Limpieza al final.
  let cotizId = null;
  const cotCreate = await call('POST', '/cotizaciones', {
    bu: 'broker', origen: 'GDL', destino: 'MTY', precio: 12345.67,
    data: { distanciaKm: 800, casetasTotal: 1500 },
  }, true);
  log(cotCreate.status === 200 && cotCreate.data && cotCreate.data.id, 'POST /cotizaciones');
  if (cotCreate.data && cotCreate.data.id) cotizId = cotCreate.data.id;
  const cotList = await call('GET', '/cotizaciones', null, true);
  log(cotList.status === 200 && Array.isArray(cotList.data), 'GET /cotizaciones', 'n=' + (Array.isArray(cotList.data) ? cotList.data.length : '?'));

  // 9e) Casetas: el catálogo de la RNC quedó sembrado (>1000) + actualizar tarifa.
  const casList = await call('GET', '/casetas?q=carbonera', null, true);
  const casOk = casList.status === 200 && Array.isArray(casList.data) && casList.data.length > 0;
  log(casOk, 'GET /casetas?q=carbonera', 'n=' + (Array.isArray(casList.data) ? casList.data.length : '?'));
  if (casOk) {
    const cid = casList.data[0].id;
    const upd = await call('PUT', '/casetas/' + cid, { tarifa: 123.45 }, true);
    log(upd.status === 200 && Number(upd.data?.tarifa) === 123.45, 'PUT /casetas/:id (tarifa)');
    await call('PUT', '/casetas/' + cid, { tarifa: null }, true); // limpieza
  }

  // 9f) Cotizador ruta (TollGuru): el endpoint existe. En CI no hay key → 503;
  // con key configurada → 200/502. Lo que importa es que NO sea 404.
  const ruta = await call('POST', '/cotizaciones/ruta', { origen: 'GDL', destino: 'MTY', vehicleType: '5AxlesTruck' }, true);
  log(ruta.status !== 404 && ruta.status !== 401, 'POST /cotizaciones/ruta (endpoint vivo)', 'status ' + ruta.status);

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

  // 11b) Limpieza del gasto operativo de prueba
  if (gastoOpId) {
    const del = await call('DELETE', '/gastos-operativos/' + gastoOpId, null, true);
    log(del.status === 200, 'DELETE /gastos-operativos/:id (limpieza)');
  }

  // 11c) Limpieza del mantenimiento de prueba
  if (mantId) {
    const del = await call('DELETE', '/mantenimientos/' + mantId, null, true);
    log(del.status === 200, 'DELETE /mantenimientos/:id (limpieza)');
  }

  // 11d) Limpieza de la cotización de prueba
  if (cotizId) {
    const del = await call('DELETE', '/cotizaciones/' + cotizId, null, true);
    log(del.status === 200, 'DELETE /cotizaciones/:id (limpieza)');
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
