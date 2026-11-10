-- Schema Postgres (Supabase) do Domma Connect Lead. Idempotente: pode rodar várias vezes.
-- Datas ficam em TEXT no formato ISO (UTC) para manter as comparações por texto do código.
CREATE OR REPLACE FUNCTION cl_now() RETURNS text LANGUAGE sql STABLE AS
$$ SELECT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') $$;

CREATE TABLE IF NOT EXISTS workspaces (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter',
  webhook_token TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT cl_now()
);
CREATE INDEX IF NOT EXISTS idx_ws_token ON workspaces(webhook_token);

CREATE TABLE IF NOT EXISTS users (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT cl_now()
);

CREATE TABLE IF NOT EXISTS connections (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('qr','oficial','simulado')),
  status TEXT NOT NULL DEFAULT 'desconectado',
  phone TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  -- QR Code: o app do PC (motor) é quem conecta. 'want' = o que o painel pediu (on/off/logout)
  want TEXT NOT NULL DEFAULT 'on',
  qr TEXT,
  engine_id TEXT,
  engine_seen_at BIGINT NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT cl_now()
);
CREATE INDEX IF NOT EXISTS idx_conn_ws ON connections(workspace_id);

CREATE TABLE IF NOT EXISTS lists (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  columns_json TEXT NOT NULL DEFAULT '[]',
  phone_column TEXT,
  name_column TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT cl_now()
);

CREATE TABLE IF NOT EXISTS contacts (
  id BIGSERIAL PRIMARY KEY,
  list_id BIGINT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  workspace_id BIGINT NOT NULL,
  row_number INTEGER NOT NULL,
  phone TEXT,
  name TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'valido',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_list ON contacts(list_id, row_number);

CREATE TABLE IF NOT EXISTS optouts (
  workspace_id BIGINT NOT NULL,
  phone TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT cl_now(),
  PRIMARY KEY (workspace_id, phone)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id BIGSERIAL PRIMARY KEY,
  workspace_id BIGINT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  list_id BIGINT NOT NULL REFERENCES lists(id),
  connection_id BIGINT NOT NULL REFERENCES connections(id),
  mode TEXT NOT NULL DEFAULT 'texto' CHECK (mode IN ('texto','template')),
  message TEXT,
  media_file TEXT,
  media_type TEXT,
  media_name TEXT,
  template_name TEXT,
  template_lang TEXT,
  template_params_json TEXT NOT NULL DEFAULT '[]',
  add_optout_footer INTEGER NOT NULL DEFAULT 1,
  speed TEXT NOT NULL DEFAULT 'segura',
  custom_min INTEGER,
  custom_max INTEGER,
  custom_every INTEGER,
  custom_pause INTEGER,
  ai_enabled INTEGER NOT NULL DEFAULT 0,
  ai_instructions TEXT,
  business_hours INTEGER NOT NULL DEFAULT 1,
  scheduled_at TEXT,
  status TEXT NOT NULL DEFAULT 'rascunho',
  next_send_at BIGINT NOT NULL DEFAULT 0,
  sent_since_pause INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  created_at TEXT NOT NULL DEFAULT cl_now(),
  started_at TEXT,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_campaigns_ws ON campaigns(workspace_id, status);

CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id BIGINT,
  phone TEXT NOT NULL,
  name TEXT,
  vars_json TEXT NOT NULL DEFAULT '{}',
  rendered TEXT,
  status TEXT NOT NULL DEFAULT 'pendente',
  error TEXT,
  wa_message_id TEXT,
  sent_at TEXT,
  updated_at TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  replied INTEGER NOT NULL DEFAULT 0,
  reply_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_phone ON messages(phone);
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id, status, id);
CREATE INDEX IF NOT EXISTS idx_messages_wa ON messages(wa_message_id);
CREATE INDEX IF NOT EXISTS idx_messages_sent ON messages(sent_at);

-- Arquivos (mídias, logos e planilhas em importação). Guardados em pedaços de até 3 MB,
-- porque a Vercel limita cada requisição a 4,5 MB.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY,
  workspace_id BIGINT NOT NULL,
  name TEXT,
  mime TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  chunks INTEGER NOT NULL DEFAULT 0,
  complete BOOLEAN NOT NULL DEFAULT false,
  temp BOOLEAN NOT NULL DEFAULT false,
  created_at TEXT NOT NULL DEFAULT cl_now()
);
CREATE TABLE IF NOT EXISTS file_chunks (
  file_id TEXT NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  idx INTEGER NOT NULL,
  data BYTEA NOT NULL,
  PRIMARY KEY (file_id, idx)
);

-- O app de PC (motor de envio) se registra aqui a cada ciclo
CREATE TABLE IF NOT EXISTS engines (
  id TEXT PRIMARY KEY,
  workspace_id BIGINT NOT NULL,
  user_id BIGINT,
  name TEXT,
  version TEXT,
  last_seen BIGINT NOT NULL DEFAULT 0
);
