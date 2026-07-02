// Seed (DEV) para VALIDAR la separación mes-actual vs total del dashboard de
// broker. Inserta fletes de broker con `created_at` repartido en varios meses
// (junio y julio 2026), mezclando finalizados (REAL), en-monitoreo (PROYECCIÓN)
// y cancelados. Luego corre la MISMA agregación de /stats/dashboard (acotada a
// los fletes sembrados) e imprime venta_mes vs venta_anual, para comprobar si el
// dashboard separa correctamente el mes del total.
//
// También incluye un flete "de frontera" (registrado el 30-jun 20:00 hora de
// México = 01-jul 02:00 UTC) para exhibir el bug de timezone: la query actual lo
// cuenta en JULIO (UTC) cuando operativamente es JUNIO (México). El script
// imprime la variante corregida (AT TIME ZONE 'America/Mexico_City') al lado.
//
// Idempotente: borra los fletes con folio 'SEED-BRK-%' (cascada a cxc/cxp/gastos)
// y los vuelve a crear.
//
// Uso: railway run -s Postgres-BRH8 -e development node scripts/seed-broker-dashboard-meses.js
import pg from 'pg';

const databaseUrl = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('FALTA DATABASE_URL/DATABASE_PUBLIC_URL (corre con railway run -s Postgres-BRH8 -e development ...)');
  process.exit(1);
}
const noSsl = /@(localhost|127\.0\.0\.1)/.test(databaseUrl) || /\.railway\.internal/.test(databaseUrl);
const pool = new pg.Pool({ connectionString: databaseUrl, ssl: noSsl ? false : { rejectUnauthorized: false } });

// Cada flete: created_at explícito (hora de México, offset -06) para controlar en
// qué mes cae. mon = clave de data.monStatus ('finalizado' | 'siniestro' | otra
// = en-monitoreo/proyección). status = columna del flete ('activo'|'cancelado').
// fcarga = datetime con offset de México (-06), tal como lo manda el frontend
// (datetime-local → ISO). El MES del dashboard se toma de fcarga (fecha de carga).
const FLETES = [
  // ── Finalizados (REAL) en JUNIO → cuentan en ANUAL, NO en el mes de julio ──
  { folio: 'SEED-BRK-J1', created: '2026-06-10 10:00:00-06', fcarga: '2026-06-10 09:00:00-06', mon: 'finalizado', status: 'activo', cobro: 30000, pago: 24000 },
  { folio: 'SEED-BRK-J2', created: '2026-06-20 10:00:00-06', fcarga: '2026-06-20 09:00:00-06', mon: 'finalizado', status: 'activo', cobro: 20000, pago: 16000 },
  // ── Finalizados (REAL) en JULIO → cuentan en MES y en ANUAL ────────────────
  { folio: 'SEED-BRK-L1', created: '2026-07-01 10:00:00-06', fcarga: '2026-07-01 09:00:00-06', mon: 'finalizado', status: 'activo', cobro: 40000, pago: 30000 },
  { folio: 'SEED-BRK-L2', created: '2026-07-02 09:00:00-06', fcarga: '2026-07-02 09:00:00-06', mon: 'finalizado', status: 'activo', cobro: 10000, pago: 7000 },
  // ── FRONTERA: cargó 30-jun (fcarga=JUNIO) pero se registró 30-jun 20:00 MX
  //    (created_at = 01-jul en UTC). Agrupando por fcarga cae en JUNIO (correcto);
  //    por created_at habría caído en julio. Valida que el fix usa el mes operativo.
  { folio: 'SEED-BRK-BORDE', created: '2026-06-30 20:00:00-06', fcarga: '2026-06-30 14:00:00-06', mon: 'finalizado', status: 'activo', cobro: 5000, pago: 3000 },
  // ── En monitoreo (PROYECCIÓN): junio y julio ──────────────────────────────
  { folio: 'SEED-BRK-M1', created: '2026-06-25 10:00:00-06', fcarga: '2026-06-25 09:00:00-06', mon: 'en-transito', status: 'activo', cobro: 12000, pago: 9000 },
  { folio: 'SEED-BRK-M2', created: '2026-07-02 08:00:00-06', fcarga: '2026-07-02 09:00:00-06', mon: 'en-transito', status: 'activo', cobro: 15000, pago: 11000 },
  // ── Cancelados: uno en julio (cancel_mes), uno en junio (solo cancel_anual) ─
  { folio: 'SEED-BRK-C1', created: '2026-07-01 12:00:00-06', fcarga: '2026-07-01 09:00:00-06', mon: 'en-transito', status: 'cancelado', cobro: 8000, pago: 6000 },
  { folio: 'SEED-BRK-C2', created: '2026-06-05 12:00:00-06', fcarga: '2026-06-05 09:00:00-06', mon: 'en-transito', status: 'cancelado', cobro: 8000, pago: 6000 },
];

// Agregación idéntica a la de /stats/dashboard YA CORREGIDA (mes/año por fcarga
// en hora de México), ACOTADA a los fletes sembrados para números deterministas.
const AGG_SQL = `
  WITH base AS (
    SELECT f.status,
           f.data->>'monStatus' AS mon,
           (date_trunc('month', COALESCE(f.fcarga, f.created_at) AT TIME ZONE 'America/Mexico_City')
              = date_trunc('month', now() AT TIME ZONE 'America/Mexico_City')) AS es_mes,
           (date_trunc('year',  COALESCE(f.fcarga, f.created_at) AT TIME ZONE 'America/Mexico_City')
              = date_trunc('year',  now() AT TIME ZONE 'America/Mexico_City')) AS es_anio,
           COALESCE(f.tarifa_cobro,0) AS cobro,
           COALESCE(f.tarifa_cobro,0) - COALESCE(f.tarifa_pago,0) AS util
      FROM fletes f
     WHERE f.bu = 'broker' AND f.folio LIKE 'SEED-BRK-%'
  )
  SELECT
    COALESCE(SUM(cobro) FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND es_anio),0) AS venta_anual,
    COALESCE(SUM(util)  FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND es_anio),0) AS util_anual,
    COALESCE(SUM(cobro) FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND es_mes),0)  AS venta_mes,
    COALESCE(SUM(util)  FILTER (WHERE mon='finalizado' AND status<>'cancelado' AND es_mes),0)  AS util_mes,
    COUNT(*) FILTER (WHERE status='cancelado' AND es_mes)  AS cancel_mes,
    COUNT(*) FILTER (WHERE status='cancelado' AND es_anio) AS cancel_anual,
    COUNT(*) FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND es_mes)  AS proy_viajes_mes,
    COUNT(*) FILTER (WHERE status<>'cancelado' AND mon NOT IN ('finalizado','siniestro') AND es_anio) AS proy_viajes_anual
  FROM base`;

const money = (v) => '$' + Number(v).toLocaleString('es-MX');

try {
  const { rows: dbinfo } = await pool.query('SELECT current_database() AS db, now() AS now_utc, now() AT TIME ZONE \'America/Mexico_City\' AS now_mx');
  console.log('Base de datos:', dbinfo[0].db);
  console.log('now() UTC:', dbinfo[0].now_utc, '| now() México:', dbinfo[0].now_mx, '\n');

  await pool.query("DELETE FROM fletes WHERE folio LIKE 'SEED-BRK-%'");

  for (const f of FLETES) {
    const { rows } = await pool.query(
      `INSERT INTO fletes
         (folio, bu, tipo, origen, destino, fcarga, fentrega, tarifa_cobro, tarifa_pago,
          status, mon_finalizado, created_at, data)
       VALUES ($1, 'broker', 'broker', 'Origen Demo', 'Destino Demo', $2, $2, $3, $4,
          $5, $6, $7::timestamptz, $8::jsonb)
       RETURNING id`,
      [
        f.folio, f.fcarga, f.cobro, f.pago, f.status,
        f.mon === 'finalizado', f.created,
        JSON.stringify({ cliente: 'CLIENTE SEED BROKER', monStatus: f.mon, _seed: true }),
      ],
    );
    const id = rows[0].id;
    // cxc/cxp para no romper vistas que los esperan (igual que el INSERT real).
    await pool.query("INSERT INTO cxc (flete_id, bu, status, data) VALUES ($1,'broker','por-facturar','{}')", [id]);
    await pool.query("INSERT INTO cxp (flete_id, bu, status, data) VALUES ($1,'broker','pendiente-prog','{}')", [id]);
  }

  // Resumen de lo insertado, por mes de CARGA (fcarga) en hora de México.
  const { rows: porMes } = await pool.query(
    `SELECT to_char(date_trunc('month', fcarga AT TIME ZONE 'America/Mexico_City'), 'YYYY-MM') AS mes_fcarga_mx,
            data->>'monStatus' AS mon, status,
            COUNT(*) AS n, SUM(tarifa_cobro)::numeric AS venta
       FROM fletes WHERE folio LIKE 'SEED-BRK-%'
      GROUP BY 1,2,3 ORDER BY 1,2,3`,
  );
  console.log('Fletes sembrados (por mes de fcarga en hora de México):');
  console.table(porMes);

  const { rows: agg } = await pool.query(AGG_SQL);
  const a = agg[0];

  console.log('\n══════════ AGREGACIÓN DEL DASHBOARD — YA CORREGIDA, por fcarga (solo SEED-BRK) ══════════');
  console.log('REAL / Finalizados:');
  console.log('  Venta Anual 2026 (total):', money(a.venta_anual), ' | Utilidad Anual:', money(a.util_anual));
  console.log('  Venta Julio (mes actual):', money(a.venta_mes),   ' | Utilidad Mes:', money(a.util_mes));
  console.log('Cancelados  → mes:', a.cancel_mes, ' anual:', a.cancel_anual);
  console.log('Proy viajes → mes:', a.proy_viajes_mes, ' anual:', a.proy_viajes_anual);

  console.log('\n────────── VALIDACIÓN ──────────');
  const esperado = { venta_mes: 50000, venta_anual: 105000, util_mes: 13000, cancel_mes: 1, proy_viajes_mes: 1 };
  const ok =
    Number(a.venta_mes) === esperado.venta_mes &&
    Number(a.venta_anual) === esperado.venta_anual &&
    Number(a.util_mes) === esperado.util_mes &&
    Number(a.cancel_mes) === esperado.cancel_mes &&
    Number(a.proy_viajes_mes) === esperado.proy_viajes_mes;
  console.log(ok
    ? '✅ Separa mes vs total por fcarga. venta_mes=$50,000 ≠ venta_anual=$105,000.\n   El flete de frontera (SEED-BRK-BORDE, fcarga 30-jun) cae en JUNIO aunque su created_at sea 01-jul UTC.'
    : `⚠️  No coincide con lo esperado ${JSON.stringify(esperado)}. Revisa el fix.`);
  console.log('\nAbre el Dashboard de dev en Broker para verlo en la UI (suma cualquier otro broker existente).');
} catch (e) {
  console.error('ERROR:', e.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
