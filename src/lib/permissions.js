// ─────────────────────────────────────────────────────────────────────────
// Permisos por módulo (manual por usuario, con presets de rol).
//
// Modelo:
//   - Cada usuario tiene un `rol` que define permisos DEFAULT por módulo (preset).
//   - Cada usuario puede tener overrides en `users.permissions` (JSONB): un mapa
//     parcial { modulo: nivel } que SOBREESCRIBE el default del rol.
//   - El permiso EFECTIVO = merge(preset[rol], overrides). admin = edit en todo.
//
// Niveles: 'none' < 'view' < 'edit'  (edit implica view).
// ─────────────────────────────────────────────────────────────────────────

export const MODULES = [
  'dashboard',
  'fletes',
  'monitoreo',
  'checklist',
  'gastos',
  'cobranza',
  'pagos',
  'transportistas',
  'documentos',
  'mantenimiento',
  'combustible',
  'clientes',
  'empleados',
  'config',
  'usuarios',
  'archivos',
];

export const LEVELS = ['none', 'view', 'edit'];
const RANK = { none: 0, view: 1, edit: 2 };

// Grupos para construir los presets de forma legible.
// NOTA: 'empleados' (RRHH) y 'archivos' NO van en ningún grupo: ambos quedan en
// 'none' por defecto para todo rol no-admin (build() rellena lo no listado con
// 'none'). El acceso se otorga manualmente por usuario en la matriz. admin
// siempre tiene 'edit' en todo.
const OPERACION = ['fletes', 'monitoreo', 'checklist', 'transportistas', 'documentos', 'mantenimiento', 'combustible', 'clientes', 'gastos'];
const FINANZAS = ['cobranza', 'pagos'];

function build(map) {
  // Completa cualquier módulo no listado en 'none'.
  const out = {};
  for (const m of MODULES) out[m] = map[m] || 'none';
  return out;
}
function group(mods, level) {
  const o = {};
  for (const m of mods) o[m] = level;
  return o;
}

// Presets DEFAULT por rol (ver tabla acordada). Editables por override por usuario.
export const ROLE_PRESETS = {
  admin: build(group(MODULES, 'edit')),
  gerente: build({
    ...group(OPERACION, 'edit'),
    ...group(FINANZAS, 'edit'),
    dashboard: 'view',
    config: 'view',
    usuarios: 'none',
  }),
  operaciones: build({
    ...group(OPERACION, 'edit'),
    ...group(FINANZAS, 'view'),
    dashboard: 'view',
  }),
  finanzas: build({
    ...group(OPERACION, 'view'),
    ...group(FINANZAS, 'edit'),
    dashboard: 'view',
  }),
  readonly: build({
    ...group(OPERACION, 'view'),
    ...group(FINANZAS, 'view'),
    dashboard: 'view',
  }),
};

function sanitizeLevel(v) {
  return LEVELS.includes(v) ? v : 'none';
}

// Permisos efectivos de un usuario: preset del rol + overrides. admin SIEMPRE
// edita todo (no puede quedar bloqueado por un override accidental).
export function effectivePerms(user) {
  const rol = user?.rol || 'readonly';
  if (rol === 'admin') return build(group(MODULES, 'edit'));
  const preset = ROLE_PRESETS[rol] || ROLE_PRESETS.readonly;
  const overrides = user?.permissions || {};
  const out = {};
  for (const m of MODULES) {
    out[m] = m in overrides ? sanitizeLevel(overrides[m]) : preset[m];
  }
  return out;
}

// ¿El mapa de permisos efectivos cumple el nivel requerido para el módulo?
export function hasPerm(perms, module, level) {
  return RANK[perms?.[module] || 'none'] >= RANK[level];
}

// ── Capacidades finas por usuario ────────────────────────────────────────────
// Flags booleanos independientes de la matriz de módulos, otorgados por usuario
// (columna users.capabilities JSONB). Ausencia de una clave = false. NO se
// otorgan implícitamente a admin: el guard requireCapability ya deja pasar a
// admin en los endpoints, y quien las CONSUME por consulta (p.ej. destinatarios
// de avisos) debe ser explícito, no todos los admins.
export const CAPABILITIES = ['editar_datos_viaje', 'recibe_avisos_datos_viaje'];

// Mapa efectivo de capacidades (solo las claves conocidas, como booleanos).
export function effectiveCapabilities(user) {
  const caps = user?.capabilities || {};
  const out = {};
  for (const c of CAPABILITIES) out[c] = caps[c] === true;
  return out;
}

// Sanea el mapa que llega de la UI: solo claves conocidas en true se persisten.
export function sanitizeCapabilities(desired) {
  const out = {};
  for (const c of CAPABILITIES) if (desired?.[c] === true) out[c] = true;
  return out;
}

// Dado un rol y un mapa EFECTIVO deseado (el que arma la UI), devuelve SOLO las
// entradas que difieren del preset → eso es lo que se guarda como overrides.
// (admin no guarda overrides: siempre edita todo.)
export function diffOverrides(rol, desired) {
  if (rol === 'admin') return {};
  const preset = ROLE_PRESETS[rol] || ROLE_PRESETS.readonly;
  const overrides = {};
  for (const m of MODULES) {
    const want = sanitizeLevel(desired?.[m]);
    if (m in (desired || {}) && want !== preset[m]) overrides[m] = want;
  }
  return overrides;
}
