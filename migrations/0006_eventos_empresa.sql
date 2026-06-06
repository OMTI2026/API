-- Calendario de RRHH: eventos de empresa (juntas, festivos, celebraciones…).
-- Los cumpleaños y aniversarios laborales NO viven aquí: se derivan en el
-- frontend de empleados.fecha_nacimiento y empleados.fecha_ingreso.

CREATE TABLE IF NOT EXISTS eventos_empresa (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu          bu_t NOT NULL,
  titulo      TEXT NOT NULL,
  descripcion TEXT,
  fecha       DATE NOT NULL,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_eventos_empresa_bu ON eventos_empresa(bu);
CREATE INDEX IF NOT EXISTS idx_eventos_empresa_fecha ON eventos_empresa(fecha);
