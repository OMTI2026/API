-- Incidencias de operador (Flota Propia): multas, daños a unidad/carga, quejas
-- de cliente, faltas administrativas, accidentes. Alimentan el Desempeño del
-- Operador (Fase 2) — cuentan como incidente y su costo se atribuye al operador.
-- La evidencia (foto/PDF) se guarda como {key,filename,mime} en `data.evidencia`.
CREATE TABLE IF NOT EXISTS incidencias (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu           bu_t NOT NULL,
  operador     TEXT NOT NULL,                       -- referencia del operador (nombre)
  fecha        DATE NOT NULL,
  tipo         TEXT NOT NULL,                       -- multa|dano_unidad|dano_carga|queja|falta_admin|accidente
  gravedad     TEXT NOT NULL DEFAULT 'media',       -- leve|media|grave
  descripcion  TEXT,
  costo        NUMERIC(12,2),
  unidad       TEXT,                                -- placa/económico (opcional)
  flete_id     UUID REFERENCES fletes(id) ON DELETE SET NULL,  -- viaje relacionado (opcional)
  estado       TEXT NOT NULL DEFAULT 'abierta',     -- abierta|resuelta
  data         JSONB NOT NULL DEFAULT '{}',         -- evidencia {key,filename,mime}
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_incidencias_bu ON incidencias(bu);
CREATE INDEX IF NOT EXISTS idx_incidencias_operador ON incidencias(lower(operador));
