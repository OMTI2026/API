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
  'clientes',
  'empleados',
  'config',
  'usuarios',
];

export const LEVELS = ['none', 'view', 'edit'];
const RANK = { none: 0, view: 1, edit: 2 };

// Grupos para construir los presets de forma legible.
const OPERACION = ['fletes', 'monitoreo', 'checklist', 'transportistas', 'clientes', 'empleados', 'gastos'];
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
