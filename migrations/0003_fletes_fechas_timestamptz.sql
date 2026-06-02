-- ELROI CargoDesk — fechas de flete con hora.
-- `fcarga` (Fecha de Carga) y `fentrega` (Cita de Entrega) eran DATE, así que la
-- hora se perdía. Se promueven a TIMESTAMPTZ para almacenar fecha + hora.
-- El cast DATE -> TIMESTAMPTZ deja los registros existentes a medianoche.
-- El frontend envía ISO (instante UTC) y muestra/edita en hora local.

ALTER TABLE fletes
  ALTER COLUMN fcarga   TYPE TIMESTAMPTZ USING fcarga::timestamptz,
  ALTER COLUMN fentrega TYPE TIMESTAMPTZ USING fentrega::timestamptz;
