// Resumen diario del CRM para el dueño (Fase 2).
//
// Compone el resumen de la actividad comercial de AYER (en hora de México) y lo
// deja en la campana de los usuarios con rol 'admin'. Idempotente por día
// (dedupeKey = crm-digest:<fecha>), así que aunque el cron corra varias veces al
// día, el aviso se crea una sola vez. Se dispara desde /cron/check-alerts.
import { q } from '../db.js';
import { notifyRoleOnce } from '../routes/notifications.routes.js';

export async function crmDigest() {
  // Ventana = AYER (00:00–24:00) en America/Mexico_City, como timestamptz.
  const win = await q(`
    SELECT
      (date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') - interval '1 day') AT TIME ZONE 'America/Mexico_City' AS ini,
      (date_trunc('day', now() AT TIME ZONE 'America/Mexico_City')) AT TIME ZONE 'America/Mexico_City' AS fin,
      to_char(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') - interval '1 day', 'DD/MM/YYYY') AS etiqueta,
      to_char(date_trunc('day', now() AT TIME ZONE 'America/Mexico_City') - interval '1 day', 'YYYY-MM-DD') AS clave
  `);
  const { ini, fin, etiqueta, clave } = win.rows[0];

  // Actividades de ayer por vendedor.
  const act = await q(
    `SELECT COALESCE(responsable, '—') AS resp, count(*)::int AS n
     FROM prospecto_actividades
     WHERE fecha >= $1 AND fecha < $2
     GROUP BY 1 ORDER BY n DESC`,
    [ini, fin],
  );
  const totalAct = act.rows.reduce((a, r) => a + r.n, 0);

  // Prospectos nuevos ayer.
  const nuevos = await q(
    'SELECT count(*)::int AS n FROM prospectos WHERE created_at >= $1 AND created_at < $2',
    [ini, fin],
  );
  const nNuevos = nuevos.rows[0].n;

  // Prospectos activos estancados (>7 días sin contacto).
  const est = await q(
    `SELECT count(*)::int AS n FROM prospectos
     WHERE etapa NOT IN ('ganado', 'perdido')
       AND COALESCE(ultimo_contacto, created_at) < now() - interval '7 days'`,
  );
  const nEst = est.rows[0].n;

  // Día muerto sin nada que reportar → no se avisa (evita ruido).
  if (totalAct === 0 && nNuevos === 0 && nEst === 0) return 0;

  const porVendedor = act.rows.map((r) => `${r.resp}: ${r.n}`).join(' · ') || 'sin actividad';
  const title = `Resumen CRM — ${etiqueta}`;
  const message =
    `Ayer: ${totalAct} actividad(es) [${porVendedor}]. ` +
    `${nNuevos} prospecto(s) nuevo(s). ${nEst} estancado(s) (>7 días sin contacto).`;

  return await notifyRoleOnce('admin', {
    type: 'crm_resumen_diario',
    title,
    message,
    entityType: 'crm',
    entityId: null,
    data: { link: '/crm' },
    dedupeKey: `crm-digest:${clave}`,
  });
}
