// Devuelve las BUs visibles para el usuario.
// 'ambos' ve broker y flota; un rol fijo ve solo la suya.
// Si el cliente envió una unidad ACTIVA (header X-Active-BU) que el usuario puede
// ver, se acota a esa unidad — así Flota y Broker NUNCA mezclan registros en
// ningún endpoint que use visibleBUs.
export function visibleBUs(user) {
  const base = user.bu === 'ambos' ? ['broker', 'flota'] : [user.bu];
  if (user && user.activeBU && base.includes(user.activeBU)) return [user.activeBU];
  return base;
}

// Helper para construir el filtro WHERE bu = ANY($n)
export function buFilter(user, paramIndex) {
  return { clause: `bu = ANY($${paramIndex})`, value: visibleBUs(user) };
}

// ¿El usuario puede operar sobre esta BU?
export function canSeeBU(user, bu) {
  return visibleBUs(user).includes(bu);
}
