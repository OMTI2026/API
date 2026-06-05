-- Recursos Humanos: áreas (departamentos), puestos (catálogo de puestos) y
-- empleados (ficha completa). La jerarquía/organigrama se deriva de empleados.jefe_id
-- (auto-referencia) y del nivel del puesto.

DO $$ BEGIN
  CREATE TYPE empleado_estatus_t AS ENUM ('activo','baja','inactivo');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── Áreas / Departamentos ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS areas (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu             bu_t NOT NULL,
  nombre         TEXT NOT NULL,
  descripcion    TEXT,
  responsable_id UUID,                 -- FK a empleados (se agrega al final)
  activo         BOOLEAN NOT NULL DEFAULT true,
  data           JSONB NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_areas_bu ON areas(bu);

-- ── Puestos (catálogo) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS puestos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu          bu_t NOT NULL,
  nombre      TEXT NOT NULL,
  area_id     UUID REFERENCES areas(id) ON DELETE SET NULL,
  nivel       INT NOT NULL DEFAULT 3,   -- jerarquía: 1=Dirección, 2=Gerencia, 3=Coord/Op…
  descripcion TEXT,
  activo      BOOLEAN NOT NULL DEFAULT true,
  data        JSONB NOT NULL DEFAULT '{}',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_puestos_bu ON puestos(bu);
CREATE INDEX IF NOT EXISTS idx_puestos_area ON puestos(area_id);

-- ── Empleados (ficha) ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS empleados (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu               bu_t NOT NULL,
  nombre           TEXT NOT NULL,
  apellido_paterno TEXT,
  apellido_materno TEXT,
  email            CITEXT,
  telefono         TEXT,
  area_id          UUID REFERENCES areas(id) ON DELETE SET NULL,
  puesto_id        UUID REFERENCES puestos(id) ON DELETE SET NULL,
  jefe_id          UUID REFERENCES empleados(id) ON DELETE SET NULL,
  fecha_ingreso    DATE,
  estatus          empleado_estatus_t NOT NULL DEFAULT 'activo',
  rfc              TEXT,
  curp             TEXT,
  nss              TEXT,
  fecha_nacimiento DATE,
  -- direccion, contacto_emergencia {nombre,telefono,parentesco}, genero,
  -- estado_civil y demás campos extra viven en data (JSONB).
  data             JSONB NOT NULL DEFAULT '{}',
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_empleados_bu ON empleados(bu);
CREATE INDEX IF NOT EXISTS idx_empleados_area ON empleados(area_id);
CREATE INDEX IF NOT EXISTS idx_empleados_puesto ON empleados(puesto_id);
CREATE INDEX IF NOT EXISTS idx_empleados_jefe ON empleados(jefe_id);

-- FK diferida: responsable del área apunta a un empleado.
DO $$ BEGIN
  ALTER TABLE areas
    ADD CONSTRAINT fk_areas_responsable
    FOREIGN KEY (responsable_id) REFERENCES empleados(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
