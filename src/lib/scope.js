// Devuelve las BUs visibles para el usuario.
// 'ambos' ve broker y flota; un rol fijo ve solo la suya.
export function visibleBUs(user) {
  return user.bu === 'ambos' ? ['broker', 'flota'] : [user.bu];
}

// Helper para construir el filtro WHERE bu = ANY($n)
export function buFilter(user, paramIndex) {
  return { clause: `bu = ANY($${paramIndex})`, value: visibleBUs(user) };
}

// ¿El usuario puede operar sobre esta BU?
export function canSeeBU(user, bu) {
  return visibleBUs(user).includes(bu);
}
