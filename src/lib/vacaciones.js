// ─────────────────────────────────────────────────────────────────────────
// Reglas de vacaciones según la Ley Federal del Trabajo (México).
// Espejo de TMS/lib/vacaciones.ts — mantener ambos en sync.
//
// - Art. 76 (reforma "vacaciones dignas", vigente 2023): 12 días al cumplir el
//   primer año, +2 por año hasta 20 (5º año), y del 6º en adelante +2 por cada
//   bloque de 5 años (6-10: 22, 11-15: 24, …).
// - Art. 74: días de descanso obligatorio (festivos oficiales), calculados por
//   regla (lunes movibles y el 1-oct sexenal por transmisión del Ejecutivo).
// - Política de la empresa: semana laboral Lun-Sáb → solo domingos y festivos
//   NO consumen saldo. Los días del ciclo vencen al siguiente aniversario
//   (sin acumulación / carry-over).
// ─────────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad2(m)}-${pad2(d)}`;

// 'YYYY-MM-DD…' -> { y, m, d } sin pasar por Date (evita corrimientos de TZ).
export function ymd(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null;
}

// Art. 76 LFT: días de vacaciones por años de servicio CUMPLIDOS.
export function diasVacacionesLFT(anios) {
  if (anios < 1) return 0;
  if (anios <= 5) return 10 + 2 * anios; // 12, 14, 16, 18, 20
  return 20 + 2 * (Math.floor((anios - 6) / 5) + 1); // 22 (6-10), 24 (11-15), …
}

// n-ésimo lunes del mes (month 1-12).
function nthLunes(year, month, n) {
  const primerDia = new Date(Date.UTC(year, month - 1, 1)).getUTCDay(); // 0=dom
  return 1 + ((8 - primerDia) % 7) + (n - 1) * 7;
}

// Art. 74 LFT: días de descanso obligatorio del año. La jornada electoral
// (fracción IX) es variable: registrarla como evento de empresa cuando aplique.
export function festivosOficiales(year) {
  const f = [
    { fecha: iso(year, 1, 1), nombre: 'Año Nuevo' },
    { fecha: iso(year, 2, nthLunes(year, 2, 1)), nombre: 'Día de la Constitución' },
    { fecha: iso(year, 3, nthLunes(year, 3, 3)), nombre: 'Natalicio de Benito Juárez' },
    { fecha: iso(year, 5, 1), nombre: 'Día del Trabajo' },
    { fecha: iso(year, 9, 16), nombre: 'Independencia de México' },
    { fecha: iso(year, 11, nthLunes(year, 11, 3)), nombre: 'Revolución Mexicana' },
    { fecha: iso(year, 12, 25), nombre: 'Navidad' },
  ];
  // Fracción VII (DOF 30-sep-2024): 1 de octubre cada 6 años por la
  // transmisión del Poder Ejecutivo Federal (2024, 2030, 2036, …).
  if (year >= 2024 && (year - 2024) % 6 === 0) {
    f.push({ fecha: iso(year, 10, 1), nombre: 'Transmisión del Poder Ejecutivo Federal' });
  }
  return f.sort((a, b) => (a.fecha < b.fecha ? -1 : 1));
}

// Set de fechas festivas 'YYYY-MM-DD' para los años de un rango.
function festivosEnRango(inicio, fin) {
  const set = new Set();
  for (let y = inicio.y; y <= fin.y; y++) for (const f of festivosOficiales(y)) set.add(f.fecha);
  return set;
}

// Días que consumen saldo en [inicio, fin] (ambos inclusive, 'YYYY-MM-DD'):
// semana Lun-Sáb → se excluyen domingos y festivos Art. 74. Devuelve 0 si el
// rango es inválido.
export function contarDiasVacaciones(inicioIso, finIso) {
  const ini = ymd(inicioIso);
  const fin = ymd(finIso);
  if (!ini || !fin) return 0;
  const festivos = festivosEnRango(ini, fin);
  let dias = 0;
  const d = new Date(Date.UTC(ini.y, ini.m - 1, ini.d));
  const tope = Date.UTC(fin.y, fin.m - 1, fin.d);
  while (d.getTime() <= tope) {
    const esDomingo = d.getUTCDay() === 0;
    const fecha = iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
    if (!esDomingo && !festivos.has(fecha)) dias++;
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return dias;
}

// Aniversario k de la fecha de ingreso, como 'YYYY-MM-DD' (29-feb cae en 1-mar
// los años no bisiestos, comportamiento de Date.UTC).
function aniversario(ingreso, k) {
  const d = new Date(Date.UTC(ingreso.y + k, ingreso.m - 1, ingreso.d));
  return iso(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

// Ciclo vacacional vigente a la fecha `hoyIso`: ventana [último aniversario,
// siguiente aniversario). El derecho corresponde a los años cumplidos y VENCE
// al cerrar el ciclo (política sin acumulación). Antes del primer aniversario
// no hay derecho (anios = 0, derecho = 0).
export function cicloVacacional(fechaIngresoIso, hoyIso) {
  const ing = ymd(fechaIngresoIso);
  const hoy = ymd(hoyIso);
  if (!ing || !hoy) return null;
  let anios = hoy.y - ing.y;
  if (hoy.m < ing.m || (hoy.m === ing.m && hoy.d < ing.d)) anios--;
  if (anios < 1) return { anios: 0, derecho: 0, inicio: null, fin: aniversario(ing, 1) };
  return {
    anios,
    derecho: diasVacacionesLFT(anios),
    inicio: aniversario(ing, anios),
    fin: aniversario(ing, anios + 1),
  };
}
