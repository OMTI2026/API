-- Pagos del programa semanal de casetas a IAVE (Flota Propia). Cada fila marca
-- una SEMANA de cruce (semana ISO, p.ej. '2026-W22') como PAGADA: guarda el monto
-- que se pagó (snapshot del lote al momento del pago), la fecha de pago programada
-- (vencimiento +30 días) y la fecha real en que se registró el pago, más una nota
-- opcional (folio de transferencia). Una semana = un registro (único por bu+semana).
-- Marcar pagado = INSERT/UPSERT; deshacer = DELETE. Lo usan el programa de pago y
-- el flujo neto semanal para excluir lo ya pagado.

CREATE TABLE IF NOT EXISTS casetas_pagos (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu           bu_t NOT NULL,
  semana       TEXT NOT NULL,         -- semana ISO de cruce (YYYY-Www)
  monto        NUMERIC,               -- monto pagado (snapshot del lote)
  fecha_pago   DATE,                  -- vencimiento programado (lunes + 30)
  pagado_at    DATE NOT NULL DEFAULT (now() AT TIME ZONE 'America/Mexico_City'),
  nota         TEXT,                  -- folio de transferencia / referencia (opcional)
  data         JSONB NOT NULL DEFAULT '{}',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_casetas_pagos_bu_semana ON casetas_pagos(bu, semana);
CREATE INDEX IF NOT EXISTS idx_casetas_pagos_bu ON casetas_pagos(bu);
