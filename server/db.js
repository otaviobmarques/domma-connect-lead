import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, 'auth'), { recursive: true });

export const db = new Database(path.join(DATA_DIR, 'connect-lead.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS workspaces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  plan TEXT NOT NULL DEFAULT 'starter',
  webhook_token TEXT,
  settings_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'owner',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('qr','oficial','simulado')),
  status TEXT NOT NULL DEFAULT 'desconectado',
  phone TEXT,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS lists (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  columns_json TEXT NOT NULL DEFAULT '[]',
  phone_column TEXT,
  name_column TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  valid INTEGER NOT NULL DEFAULT 0,
  invalid INTEGER NOT NULL DEFAULT 0,
  duplicates INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
  workspace_id INTEGER NOT NULL,
  row_number INTEGER NOT NULL,
  phone TEXT,
  name TEXT,
  data_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'valido',
  error TEXT
);
CREATE INDEX IF NOT EXISTS idx_contacts_list ON contacts(list_id);
CREATE TABLE IF NOT EXISTS optouts (
  workspace_id INTEGER NOT NULL,
  phone TEXT NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (workspace_id, phone)
);
CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id INTEGER NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  list_id INTEGER NOT NULL REFERENCES lists(id),
  connection_id INTEGER NOT NULL REFERENCES connections(id),
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
  next_send_at INTEGER NOT NULL DEFAULT 0,
  sent_since_pause INTEGER NOT NULL DEFAULT 0,
  pause_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  contact_id INTEGER,
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
CREATE INDEX IF NOT EXISTS idx_messages_campaign ON messages(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_wa ON messages(wa_message_id);
`);

export const now = () => new Date().toISOString();
export const parseJSON = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };
