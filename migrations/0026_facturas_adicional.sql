-- Facturas de adicional (Flota Propia). Un mismo flete puede tener VARIAS
-- facturas de adicional, cada una con su propio folio, fecha de factura y fecha
-- de cobro, independientes de la factura del servicio (que vive en cxc.data).
-- Nace porque el cliente suele autorizar facturar los adicionales tiempo después
-- y los paga en fecha distinta (en ~90% el servicio se cobra primero y el
-- adicional mucho después). Cada factura agrupa uno o más gastos_extra
-- (gastos_extra.factura_adic_id) y se proyecta en el Flujo Neto Semanal por su
-- fecha de cobro estimada, igual que cualquier ingreso.
CREATE TABLE IF NOT EXISTS facturas_adicional (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flete_id        UUID NOT NULL REFERENCES fletes(id) ON DELETE CASCADE,
  bu              bu_t NOT NULL,
  folio           TEXT,                                 -- número/folio de la factura del adicional
  fecha_factura   DATE,                                 -- fecha de emisión (NULL = aún por facturar)
  fecha_autoriza  DATE,                                 -- fecha en que el cliente autoriza facturarla
  monto           NUMERIC(14,2) NOT NULL DEFAULT 0,     -- total (suma de sus gastos, editable)
  fecha_cobro_est DATE,                                 -- fecha de cobro estimada (= fecha_factura + días crédito, editable)
  fecha_cobrado   DATE,                                 -- fecha real de cobro
  status          TEXT NOT NULL DEFAULT 'por-facturar', -- por-facturar | facturado | cobrado
  data            JSONB NOT NULL DEFAULT '{}',          -- obs, factCount, etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_facturas_adic_flete ON facturas_adicional(flete_id);
CREATE INDEX IF NOT EXISTS idx_facturas_adic_bu ON facturas_adicional(bu);
CREATE INDEX IF NOT EXISTS idx_facturas_adic_cobro ON facturas_adicional(fecha_cobro_est);

-- Liga cada gasto extra a la factura de adicional que lo cobra. NULL = el gasto
-- aún no se factura como adicional (se queda sumado en la factura del servicio,
-- comportamiento actual). Al asignarlo a una factura de adicional, sale del
-- subtotal del servicio para no doble-contar.
ALTER TABLE gastos_extra
  ADD COLUMN IF NOT EXISTS factura_adic_id UUID REFERENCES facturas_adicional(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS idx_gastos_factura_adic ON gastos_extra(factura_adic_id);

-- Referencia opcional de un archivo a un sub-registro (aquí: el PDF/XML de una
-- factura de adicional apunta a facturas_adicional.id vía archivos.ref_id, con
-- contexto='factura_adicional'). Nullable: no afecta a los archivos existentes.
ALTER TABLE archivos
  ADD COLUMN IF NOT EXISTS ref_id UUID;
CREATE INDEX IF NOT EXISTS idx_archivos_ref ON archivos(ref_id);
