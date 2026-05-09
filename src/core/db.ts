import { mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";

const DB_PATH = "data/bot.db";

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_version (
    version INTEGER PRIMARY KEY
  )`,
  // All Discord-side IDs (snowflakes) are stored as TEXT, not INTEGER, to
  // avoid JS Number precision loss - Discord snowflakes routinely exceed
  // 2^53 and would round to the nearest representable double when read
  // back via better-sqlite3's default Number conversion. Internal sequence
  // IDs (mod_notes.id, strikes.id, etc.) stay INTEGER since they're small.
  `CREATE TABLE IF NOT EXISTS users (
    discord_id TEXT PRIMARY KEY,
    reddit_username TEXT,
    joined_at TIMESTAMP,
    first_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS mod_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mod_id TEXT NOT NULL,
    note TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS strikes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mod_id TEXT NOT NULL,
    severity INTEGER NOT NULL,
    reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    expires_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS dm_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reporter_id TEXT NOT NULL,
    reported_user_id TEXT NOT NULL,
    screenshot_url TEXT,
    context TEXT,
    status TEXT DEFAULT 'open',
    mod_decision TEXT,
    mod_channel_message_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS birthdays (
    user_id TEXT PRIMARY KEY,
    month INTEGER NOT NULL,
    day INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS reaction_role_messages (
    message_id TEXT PRIMARY KEY,
    channel_id TEXT NOT NULL,
    config_json TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS prompts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt_text TEXT NOT NULL,
    category TEXT,
    last_used TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS ban_sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    user_id TEXT,
    reddit_username TEXT,
    action TEXT NOT NULL,
    reason TEXT,
    synced_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE TABLE IF NOT EXISTS pending_invites (
    invite_code TEXT PRIMARY KEY,
    reddit_username TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mod_notes_user ON mod_notes(user_id)`,
  `CREATE INDEX IF NOT EXISTS idx_strikes_user ON strikes(user_id, expires_at)`,
  `CREATE INDEX IF NOT EXISTS idx_dm_reports_reported ON dm_reports(reported_user_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_dm_reports_status ON dm_reports(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ban_sync_reddit ON ban_sync_log(reddit_username)`,
];

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;
  mkdirSync(dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  for (const stmt of SCHEMA) _db.exec(stmt);
  return _db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
