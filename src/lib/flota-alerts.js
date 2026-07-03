// Alertas proactivas de Flota Propia.
//
// Recorre los datos que ya viven en la BD (vencimientos de documentos y pagos a
// proveedores vencidos) y crea avisos en la campana para los usuarios con la
// capacidad `recibe_alertas_flota`. Idempotente por `dedupeKey` (no repite el
// mismo aviso en cada corrida). Lo dispara el endpoint /cron/check-alerts.
import { q } from '../db.js';
import { notifyCapabilityOnce } from '../routes/notifications.routes.js';

const CAP = 'recibe_alertas_flota';
const POR_VENCER_DIAS = 30; // ventana de aviso (mismo umbral que el frontend)

// Campos de vencimiento por entidad (viven en documentos.data, los define el
// frontend). Etiqueta legible para el título del aviso.
const VTOS = {
  operador: [
    ['ineVto', 'INE'],
    ['licenciaVto', 'Licencia'],
    ['aptoVto', 'Apto médico'],
  ],
  tracto: [
    ['polizaVto', 'Póliza'],
    ['verificacionVto', 'Verificación'],
    ['permisoSctVto', 'Permiso SCT'],
    ['inspeccionVto', 'Inspección físico-mecánica'],
  ],
  remolque: [
    ['polizaVto', 'Póliza'],
    ['inspeccionVto', 'Inspección físico-mecánica'],
  ],
};

const hoyISO = () => new Date().toISOString().slice(0, 10);

function diasHasta(fechaISO) {
  const t = Date.parse(fechaISO + 'T00:00:00Z');
  if (!Number.isFinite(t)) return null;
  const hoy = Date.parse(hoyISO() + 'T00:00:00Z');
  return Math.round((t - hoy) / 86400000);
}

// Documentos de flota por vencer (≤30 días) o vencidos.
async function alertasDocumentos() {
  let creadas = 0;
  const { rows } = await q("SELECT id, entidad, referencia, data FROM documentos WHERE bu = 'flota'");
  for (const doc of rows) {
    const campos = VTOS[doc.entidad] || [];
    const data = doc.data || {};
    for (const [key, label] of campos) {
      const vto = data[key];
      if (!vto) continue;
      const fecha = String(vto).slice(0, 10);
      const dias = diasHasta(fecha);
      if (dias == null || dias > POR_VENCER_DIAS) continue;
      const ref = doc.referencia || doc.id;
      const title =
        dias < 0
          ? `${label} de ${ref} VENCIDA hace ${-dias} día${-dias === 1 ? '' : 's'}`
          : `${label} de ${ref} vence en ${dias} día${dias === 1 ? '' : 's'}`;
      creadas += await notifyCapabilityOnce(CAP, {
        type: 'alerta_vencimiento_doc',
        title,
        message: 'Actualiza el documento en Vencimientos.',
        entityType: 'documento',
        entityId: doc.id,
        data: { link: '/vencimientos', referencia: ref, campo: key, dias },
        dedupeKey: `doc:${doc.id}:${key}:${fecha}`,
      });
    }
  }
  return creadas;
}

// Pagos a proveedores de flota, pendientes y vencidos.
async function alertasPagosVencidos() {
  const { rows } = await q(
    `SELECT id, proveedor, monto, data FROM gastos_operativos
      WHERE bu = 'flota'
        AND COALESCE(data->>'estado', 'pendiente') <> 'pagado'
        AND (data->>'vencimiento') IS NOT NULL
        AND (data->>'vencimiento') < $1`,
    [hoyISO()],
  );
  let creadas = 0;
  for (const g of rows) {
    const prov = g.proveedor || 'proveedor';
    const monto = Number(g.monto) || 0;
    const venc = g.data?.vencimiento;
    creadas += await notifyCapabilityOnce(CAP, {
      type: 'alerta_pago_vencido',
      title: `Pago vencido a ${prov} — $${monto.toLocaleString('es-MX')}`,
      message: `Venció el ${venc}. Revísalo en Pago a Proveedores.`,
      entityType: 'gasto_operativo',
      entityId: g.id,
      data: { link: '/pagos', proveedor: prov, monto },
      dedupeKey: `pago:${g.id}`,
    });
  }
  return creadas;
}

// Corre todas las revisiones y devuelve el desglose de avisos creados.
export async function checkFlotaAlerts() {
  const documentos = await alertasDocumentos();
  const pagos = await alertasPagosVencidos();
  return { documentos, pagos, total: documentos + pagos };
}
