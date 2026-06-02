-- ELROI CargoDesk — esquema inicial
-- Extensiones
CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- Enums
DO $$ BEGIN
  CREATE TYPE bu_t AS ENUM ('broker','flota','ambos');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rol_t AS ENUM ('admin','gerente','operaciones','finanzas','readonly');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE flete_st_t AS ENUM ('activo','cancelado','finalizado');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Usuarios (auth robusta)
CREATE TABLE IF NOT EXISTS users (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nombre                TEXT NOT NULL,
  email                 CITEXT UNIQUE NOT NULL,
  pass_hash             TEXT NOT NULL,                -- Argon2id
  rol                   rol_t NOT NULL,
  bu                    bu_t NOT NULL,
  activo                BOOLEAN NOT NULL DEFAULT true,
  must_change_password  BOOLEAN NOT NULL DEFAULT false,
  totp_secret           TEXT,                          -- 2FA activo
  totp_pending          TEXT,                          -- 2FA en configuración
  failed_logins         INT NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Refresh tokens (rotación + revocación)
CREATE TABLE IF NOT EXISTS refresh_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL,                           -- SHA-256 del token opaco
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);
CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);

-- Catálogos
CREATE TABLE IF NOT EXISTS clients (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu         bu_t NOT NULL,
  empresa    TEXT NOT NULL,
  rfc        TEXT,
  contacto   TEXT,
  credito    NUMERIC,
  dias_pago  INT,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_bu ON clients(bu);

CREATE TABLE IF NOT EXISTS carriers (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu         bu_t NOT NULL,
  nombre     TEXT NOT NULL,
  rfc        TEXT,
  contacto   TEXT,
  credito    NUMERIC,
  tiene_gps  BOOLEAN DEFAULT false,
  data       JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_carriers_bu ON carriers(bu);

-- Fletes
CREATE TABLE IF NOT EXISTS fletes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  folio           TEXT,
  folio_cli       TEXT,
  bu              bu_t NOT NULL,
  cliente_id      UUID REFERENCES clients(id),
  carrier_id      UUID REFERENCES carriers(id),
  tipo            TEXT,
  origen          TEXT,
  destino         TEXT,
  fcarga          DATE,
  fentrega        DATE,
  tarifa_cobro    NUMERIC,
  tarifa_pago     NUMERIC,
  status          flete_st_t NOT NULL DEFAULT 'activo',
  mon_finalizado  BOOLEAN NOT NULL DEFAULT false,
  gastos_liberado BOOLEAN NOT NULL DEFAULT false,
  data            JSONB NOT NULL DEFAULT '{}',   -- placas, gps, operador, cancelacion, etc.
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_fletes_bu ON fletes(bu);
CREATE INDEX IF NOT EXISTS idx_fletes_status ON fletes(status);
CREATE INDEX IF NOT EXISTS idx_fletes_cliente ON fletes(cliente_id);

-- Gastos extra
CREATE TABLE IF NOT EXISTS gastos_extra (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flete_id    UUID NOT NULL REFERENCES fletes(id) ON DELETE CASCADE,
  tipo        TEXT,
  descripcion TEXT,
  cobro       NUMERIC,
  pago        NUMERIC,
  fecha       DATE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_gastos_flete ON gastos_extra(flete_id);

-- Cobranza (CxC) y Pago a proveedores (CxP) — flujos secuenciales en data JSONB
CREATE TABLE IF NOT EXISTS cxc (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flete_id   UUID NOT NULL UNIQUE REFERENCES fletes(id) ON DELETE CASCADE,
  bu         bu_t NOT NULL,
  status     TEXT,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cxc_bu ON cxc(bu);

CREATE TABLE IF NOT EXISTS cxp (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flete_id   UUID NOT NULL UNIQUE REFERENCES fletes(id) ON DELETE CASCADE,
  bu         bu_t NOT NULL,
  status     TEXT,
  data       JSONB NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_cxp_bu ON cxp(bu);

-- Histórico mensual de stats
CREATE TABLE IF NOT EXISTS stats_historico (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bu        bu_t NOT NULL,
  mes       TEXT NOT NULL,            -- 'YYYY-MM'
  fletes    INT,
  ingresos  NUMERIC,
  costos    NUMERIC,
  utilidad  NUMERIC,
  UNIQUE (bu, mes)
);

-- Archivos en R2 (metadata; el binario vive en el bucket)
CREATE TABLE IF NOT EXISTS archivos (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  flete_id    UUID REFERENCES fletes(id) ON DELETE CASCADE,
  contexto    TEXT NOT NULL,          -- pod | factura | comprobante | complemento | evidencia_img | estado_cuenta
  modulo      TEXT,                   -- cxc | cxp | flete
  r2_key      TEXT NOT NULL,
  filename    TEXT,
  mime        TEXT,
  bytes       BIGINT,
  uploaded_by UUID REFERENCES users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_archivos_flete ON archivos(flete_id);
CREATE INDEX IF NOT EXISTS idx_archivos_contexto ON archivos(contexto);
