// Seed de datos DEMO para Broker (dev). Crea ~12 servicios que recorren TODO el
// proceso para apreciar cada módulo y los estados que produce: Dashboard
// (real vs proyección), Fletes, Monitoreo (incl. siniestro), Gastos Extra
// (columna Folio Cliente + fecha), Cobranza y Pago de Proveedores.
//
// Habla con la API por HTTP (mismas validaciones/efectos que la app). No usa
// dependencias (fetch nativo de Node 18+). Es idempotente/reanudable: marca todo
// con data.seedTag y, por servicio, no duplica (busca por folio_cli + seedTag).
//
//   BASE_URL=https://tms-dev-development.up.railway.app/api \
//   ADMIN_EMAIL=admin@elroi.mx ADMIN_PASSWORD='...' \
//   node scripts/seed-demo.js
//
// Opcionales: SEED_TAG (default demo-broker), DRY=1 (solo imprime el plan).
// OJO: úsalo solo en dev. Para re-sembrar limpio usa otro SEED_TAG.

const BASE = (process.env.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const EMAIL = process.env.ADMIN_EMAIL || 'admin@elroi.mx';
const PASSWORD = process.env.ADMIN_PASSWORD || 'elroi2025';
const TAG = process.env.SEED_TAG || 'demo-broker';
const DRY = process.env.DRY === '1';
const BU = 'broker';

let token = null;

async function api(method, path, body) {
  // Solo mandamos Content-Type cuando hay cuerpo: Fastify rechaza un body vacío
  // con content-type application/json (p.ej. POST /gastos/liberar/:id sin payload).
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  const res = await fetch(BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${typeof data === 'string' ? data : JSON.stringify(data)}`);
  return data;
}

// Fechas relativas a hoy: d() -> 'YYYY-MM-DD', ts() -> ISO con hora.
const DAY = 86400000;
const d = (off = 0) => new Date(Date.now() + off * DAY).toISOString().slice(0, 10);
const ts = (off = 0, hour = 8) => { const x = new Date(Date.now() + off * DAY); x.setUTCHours(hour, 0, 0, 0); return x.toISOString(); };

const CLIENTES = [
  { empresa: 'Comercializadora del Norte SA', rfc: 'CNO150210AB1', contacto: 'Laura Mendoza · 81-1234-5678', dias_pago: 30, credito: 500000 },
  { empresa: 'Aceros y Perfiles Bajío SA', rfc: 'APB180722QX4', contacto: 'Jorge Salinas · 477-321-0099', dias_pago: 45, credito: 800000 },
  { empresa: 'Distribuidora La Península SA', rfc: 'DLP120909ML7', contacto: 'Mariana Cob · 999-456-7788', dias_pago: 15, credito: 300000 },
];
const PROVEEDORES = [
  { nombre: 'Autotransportes El Águila', rfc: 'AAG110301RT2', contacto: 'Pedro Ramírez · 55-8800-1122', tiene_gps: true },
  { nombre: 'Fletes del Pacífico SA de CV', rfc: 'FPA160815KL9', contacto: 'Sergio Núñez · 33-2211-3344', tiene_gps: true },
  { nombre: 'Transportes TRC Nacional', rfc: 'TRC140620PP0', contacto: 'Ana Beltrán · 222-665-9090', tiene_gps: false },
];

const gCaseta = (off) => ({ tipo: 'caseta', descripcion: 'Casetas ruta (IAVE)', cobro: 1850, pago: 1850, fecha: d(off) });
const gManiobra = (off) => ({ tipo: 'maniobra', descripcion: 'Maniobra de carga/descarga', cobro: 1200, pago: 800, fecha: d(off) });
const gEstadia = (off) => ({ tipo: 'estadia', descripcion: 'Estadía 1 día en destino', cobro: 2500, pago: 1500, fecha: d(off) });

// cli/prov = índice en los catálogos. mon = key de monStatus. fin = mon_finalizado.
const SERVICIOS = [
  { cli: 0, prov: 0, tipo: 'Seca 53', origen: 'Monterrey, NL', destino: 'CDMX', cobro: 32000, pago: 23000, folio_cli: 'OC-2026-1001', mon: 'asignado', fcarga: 2, fentrega: 4 },
  { cli: 1, prov: 1, tipo: 'Refrigerado', origen: 'León, GTO', destino: 'Guadalajara, JAL', cobro: 28500, pago: 20000, folio_cli: 'OC-2026-1002', mon: 'confirmado', fcarga: 1, fentrega: 3 },
  { cli: 2, prov: 2, tipo: 'Plataforma', origen: 'Mérida, YUC', destino: 'Cancún, QROO', cobro: 19500, pago: 13500, folio_cli: 'PED-5588', mon: 'en-transito', fcarga: -1, fentrega: 1 },
  { cli: 0, prov: 1, tipo: 'Seca 48', origen: 'Saltillo, COAH', destino: 'Querétaro, QRO', cobro: 26000, pago: 18500, folio_cli: 'OC-2026-1003', mon: 'arribo-descarga', fcarga: -2, fentrega: 0 },
  { cli: 1, prov: 2, tipo: 'Plataforma', origen: 'Irapuato, GTO', destino: 'Toluca, MEX', cobro: 24000, pago: 17000, folio_cli: 'PED-5601', mon: 'siniestro', fcarga: -3, fentrega: -1 },
  { cli: 2, prov: 0, tipo: 'Seca 53', origen: 'Campeche, CAM', destino: 'Villahermosa, TAB', cobro: 21000, pago: 14500, folio_cli: 'PED-5610', mon: 'finalizado', fin: true, fcarga: -4, fentrega: -2 },
  { cli: 0, prov: 1, tipo: 'Refrigerado', origen: 'Monterrey, NL', destino: 'Puebla, PUE', cobro: 34000, pago: 24000, folio_cli: 'OC-2026-1004', mon: 'finalizado', fin: true, fcarga: -5, fentrega: -3, gastos: [gCaseta(-3), gManiobra(-3)] },
  { cli: 1, prov: 2, tipo: 'Seca 48', origen: 'Guadalajara, JAL', destino: 'Aguascalientes, AGS', cobro: 22500, pago: 15500, folio_cli: 'OC-2026-1005', mon: 'finalizado', fin: true, fcarga: -6, fentrega: -4, gastos: [gCaseta(-4)], liberar: true },
  { cli: 2, prov: 0, tipo: 'Plataforma', origen: 'Cancún, QROO', destino: 'Mérida, YUC', cobro: 20000, pago: 13500, folio_cli: 'PED-5620', mon: 'finalizado', fin: true, fcarga: -8, fentrega: -6, gastos: [gManiobra(-6)], liberar: true, cxc: { factura: 'A-10231', fechaCobro: d(20), ffinServicio: d(-6) }, cxp: { facturaP: 'F-7781', frecep: d(-5), fechaPago: d(10) } },
  { cli: 0, prov: 1, tipo: 'Seca 53', origen: 'CDMX', destino: 'Monterrey, NL', cobro: 33000, pago: 23500, folio_cli: 'OC-2026-1006', mon: 'finalizado', fin: true, fcarga: -12, fentrega: -10, gastos: [gCaseta(-10), gEstadia(-9)], liberar: true, cxc: { factura: 'A-10198', fechaCobro: d(-2), fechaCobrado: d(-1), complemento: 'CP-10198', ffinServicio: d(-10) }, cxp: { facturaP: 'F-7765', frecep: d(-9), fechaPago: d(3) } },
  { cli: 1, prov: 2, tipo: 'Refrigerado', origen: 'León, GTO', destino: 'CDMX', cobro: 30000, pago: 21000, folio_cli: 'OC-2026-1007', mon: 'finalizado', fin: true, fcarga: -16, fentrega: -14, gastos: [gManiobra(-14)], liberar: true, cxc: { factura: 'A-10150', fechaCobro: d(-6), fechaCobrado: d(-4), complemento: 'CP-10150', ffinServicio: d(-14) }, cxp: { facturaP: 'F-7740', frecep: d(-13), fechaPago: d(-3) } },
  { cli: 2, prov: 0, tipo: 'Seca 48', origen: 'Villahermosa, TAB', destino: 'Mérida, YUC', cobro: 18000, pago: 12000, folio_cli: 'PED-5650', cancelar: true, fcarga: 1, fentrega: 3 },
];

async function ensureCatalogo(path, list, matchKey) {
  const existing = await api('GET', path);
  const byKey = new Map(existing.filter((x) => x.bu === BU).map((x) => [String(x[matchKey]).toLowerCase(), x]));
  const out = [];
  for (const item of list) {
    const found = byKey.get(String(item[matchKey]).toLowerCase());
    if (found) { out.push(found); console.log(`   = ${path} ya existe: ${item[matchKey]}`); continue; }
    if (DRY) { out.push({ id: 'DRY', ...item }); console.log(`   + (DRY) crear ${path}: ${item[matchKey]}`); continue; }
    const created = await api('POST', path, { bu: BU, ...item, data: { seedTag: TAG } });
    out.push(created); console.log(`   + ${path} creado: ${item[matchKey]} (${created.id})`);
  }
  return out;
}

async function main() {
  console.log(`\n▶ Seed DEMO Broker → ${BASE}  tag=${TAG}${DRY ? '  [DRY-RUN]' : ''}`);
  const login = await api('POST', '/auth/login', { email: EMAIL, password: PASSWORD });
  token = login.accessToken;
  console.log(`✓ login: ${login.user?.email} (rol=${login.user?.rol}, bu=${login.user?.bu})`);
  if (login.user?.bu === 'flota') { console.error('✗ El usuario es de BU flota; necesita broker o ambos.'); process.exit(1); }

  console.log('\n• Clientes');
  const clientes = await ensureCatalogo('/clients', CLIENTES, 'empresa');
  console.log('• Proveedores');
  const carriers = await ensureCatalogo('/carriers', PROVEEDORES, 'nombre');

  // Índice de servicios ya sembrados (reanudable, por folio_cli + seedTag).
  const fletes = await api('GET', '/fletes?limit=500');
  const seedByFolioCli = new Map(fletes.filter((f) => f?.data?.seedTag === TAG && f.folio_cli).map((f) => [f.folio_cli, f]));

  console.log('\n• Servicios');
  let n = 0;
  for (const s of SERVICIOS) {
    n++;
    const etiqueta = s.cancelar ? 'CANCELADO' : s.cxc?.complemento ? 'COBRADO+CxP' : s.cxc ? 'FACTURADO' : s.liberar ? 'LIBERADO' : s.gastos ? 'GASTOS' : s.fin ? 'FINALIZADO' : `MON:${s.mon}`;
    if (DRY) { console.log(`   ${String(n).padStart(2)}. (DRY) ${etiqueta} ${s.origen}→${s.destino} folioCli=${s.folio_cli}`); continue; }

    let flete = seedByFolioCli.get(s.folio_cli);
    let nota = '';
    if (!flete) {
      flete = await api('POST', '/fletes', {
        bu: BU,
        cliente_id: clientes[s.cli].id,
        carrier_id: carriers[s.prov].id,
        tipo: s.tipo, origen: s.origen, destino: s.destino,
        folio_cli: s.folio_cli,
        tarifa_cobro: s.cobro, tarifa_pago: s.pago,
        fcarga: ts(s.fcarga, 8), fentrega: ts(s.fentrega, 18),
        data: { seedTag: TAG, operador: 'Operador Demo', placas: 'XY-' + (1000 + n) },
      });
    } else { nota = ' (existente, reconciliado)'; }

    if (s.mon) await api('PATCH', `/fletes/${flete.id}/monitoreo`, { mon_finalizado: !!s.fin, data: { monStatus: s.mon } });
    if (s.gastos?.length) {
      const existentes = await api('GET', `/gastos/by-flete/${flete.id}`);
      if (!existentes.length) for (const g of s.gastos) await api('POST', '/gastos', { flete_id: flete.id, ...g });
    }
    if (s.liberar && !flete.gastos_liberado) {
      try { await api('POST', `/gastos/liberar/${flete.id}`); } catch (e) { if (!/→ 409/.test(e.message)) throw e; }
    }
    if (s.cxc) await api('PUT', `/cxc/by-flete/${flete.id}`, { data: s.cxc });
    if (s.cxp) await api('PUT', `/cxp/by-flete/${flete.id}`, { data: s.cxp });
    if (s.cancelar && flete.status !== 'cancelado') {
      await api('POST', `/fletes/${flete.id}/cancelar`, { motivo: 'Cliente reprogramó embarque', responsable: 'Operaciones (demo)' });
    }

    console.log(`   ${String(n).padStart(2)}. ${flete.folio.padEnd(10)} ${etiqueta.padEnd(12)} ${s.origen} → ${s.destino}  (folioCli ${s.folio_cli})${nota}`);
  }

  console.log(`\n✓ Listo. ${SERVICIOS.length} servicios con tag ${TAG}.`);
  console.log('  Revisa: Dashboard (real vs proyección), Fletes, Monitoreo, Gastos Extra (Folio Cliente + fecha), Cobranza y Pago de Proveedores.');
  console.log('  Nota: marcar un pago como PAGADO/CERRADO en CxP requiere subir el comprobante PDF desde la UI (paso file-driven).');
}

main().catch((e) => { console.error('\n✗ Error:', e.message); process.exit(1); });
