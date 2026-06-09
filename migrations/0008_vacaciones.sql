-- Vacaciones (LFT): solicitudes del empleado aprobadas por su jefe directo.
-- El saldo NO se persiste: se deriva de empleados.fecha_ingreso (Art. 76 LFT)
-- menos los días de solicitudes aprobadas del ciclo vigente (src/lib/vacaciones.js).
-- Los festivos del Art. 74 se calculan por regla, no llevan tabla.

-- Vínculo usuario ↔ empleado: con qué ficha de RRHH solicita/aprueba un usuario
-- de la app. Backfill automático por email coincidente (ambos CITEXT).
ALTER TABLE users ADD COLUMN IF NOT EXISTS empleado_id UUID REFERENCES empleados(id) ON DELETE SET NULL;
UPDATE users u SET empleado_id = e.id
  FROM empleados e
 WHERE u.empleado_id IS NULL AND e.email IS NOT NULL AND u.email = e.email;
CREATE INDEX IF NOT EXISTS idx_users_empleado ON users(empleado_id);

DO $$ BEGIN
  CREATE TYPE vacacion_estado_t AS ENUM ('pendiente','aprobada','rechazada','cancelada');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS vacaciones (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu             bu_t NOT NULL,
  empleado_id    UUID NOT NULL REFERENCES empleados(id) ON DELETE CASCADE,
  fecha_inicio   DATE NOT NULL,
  fecha_fin      DATE NOT NULL,
  dias           INT NOT NULL,            -- días hábiles que consumen saldo (calcula el API)
  comentario     TEXT,
  estado         vacacion_estado_t NOT NULL DEFAULT 'pendiente',
  resuelto_por   UUID REFERENCES users(id) ON DELETE SET NULL,  -- quién aprobó/rechazó
  motivo_rechazo TEXT,
  resuelto_at    TIMESTAMPTZ,
  data           JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (fecha_fin >= fecha_inicio)
);
CREATE INDEX IF NOT EXISTS idx_vacaciones_empleado ON vacaciones(empleado_id);
CREATE INDEX IF NOT EXISTS idx_vacaciones_estado ON vacaciones(estado);
CREATE INDEX IF NOT EXISTS idx_vacaciones_fechas ON vacaciones(fecha_inicio, fecha_fin);
CREATE INDEX IF NOT EXISTS idx_vacaciones_bu ON vacaciones(bu);
