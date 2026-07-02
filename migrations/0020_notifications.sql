-- Notificaciones persistidas por usuario (bandeja personal / campana in-app).
-- Cada fila es un aviso dirigido a un usuario (user_id). Se crean desde otros
-- endpoints (p.ej. edición de datos de viaje) hacia los usuarios que tengan la
-- capacidad correspondiente. read_at NULL = no leída.
CREATE TABLE IF NOT EXISTS notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type        TEXT NOT NULL,
  title       TEXT NOT NULL,
  message     TEXT,
  entity_type TEXT,
  entity_id   UUID,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  read_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Bandeja del usuario, más recientes primero, y conteo de no leídas.
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications (user_id) WHERE read_at IS NULL;
