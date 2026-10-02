"use strict";

// Accès à la base Postgres (Vercel Storage → Neon, ou tout Postgres).
// Variables lues : POSTGRES_URL ou DATABASE_URL.
// Tables : settings (token API OneStock) et api_logs (journal des appels API OneStock).

const { Pool } = require("pg");

const MAX_LOGS = 500;
let pool = null;
let schemaReady = null;

function connectionString() {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
}

function getPool() {
  if (!pool) {
    const url = connectionString();
    if (!url) throw Object.assign(new Error("Base de données non configurée (POSTGRES_URL ou DATABASE_URL)"), { status: 500 });
    // SSL requis pour Neon / Vercel ; désactivé pour une base locale
    const local = /sslmode=disable|@(localhost|127\.0\.0\.1)[:/]/.test(url);
    pool = new Pool({ connectionString: url, max: 3, ssl: local ? false : { rejectUnauthorized: false } });
  }
  return pool;
}

function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS settings (
        key        text PRIMARY KEY,
        value      text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE IF NOT EXISTS api_logs (
        id          bigserial PRIMARY KEY,
        created_at  timestamptz NOT NULL DEFAULT now(),
        method      text NOT NULL,
        url         text NOT NULL,
        request     jsonb,
        status      integer,
        duration_ms integer,
        response    text,
        error       text
      );
      CREATE INDEX IF NOT EXISTS api_logs_created_at_idx ON api_logs (created_at DESC);
    `).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function query(sql, params) {
  await ensureSchema();
  return getPool().query(sql, params);
}

// ---------- Paramètres (token, route de l'API) ----------

async function getSetting(key) {
  const { rows } = await query("SELECT value, updated_at FROM settings WHERE key = $1", [key]);
  return rows[0] ? { value: rows[0].value, updated_at: rows[0].updated_at } : null;
}

// Valeur vide = suppression du paramètre
async function setSetting(key, value) {
  if (!value) {
    await query("DELETE FROM settings WHERE key = $1", [key]);
    return;
  }
  await query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, value]
  );
}

async function getToken() {
  const s = await getSetting("onestock_token");
  return s ? { token: s.value, updated_at: s.updated_at } : null;
}

const setToken = (token) => setSetting("onestock_token", token);
const getApiRoot = () => getSetting("onestock_api_root");
const setApiRoot = (root) => setSetting("onestock_api_root", root);

// ---------- Journal des appels API ----------

async function addLog(entry) {
  await query(
    `INSERT INTO api_logs (method, url, request, status, duration_ms, response, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [entry.method, entry.url, entry.request ? JSON.stringify(entry.request) : null, entry.status ?? null,
      entry.duration_ms ?? null, entry.response ?? null, entry.error ?? null]
  );
  // On ne garde que les MAX_LOGS derniers appels
  await query(`DELETE FROM api_logs WHERE id <= (SELECT id FROM api_logs ORDER BY id DESC OFFSET $1 LIMIT 1)`, [MAX_LOGS]);
}

async function listLogs(limit = 100) {
  const { rows } = await query(
    `SELECT id, created_at, method, url, request, status, duration_ms, response, error
     FROM api_logs ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), MAX_LOGS)]
  );
  return rows;
}

async function clearLogs() {
  await query("DELETE FROM api_logs");
}

module.exports = { getToken, setToken, getApiRoot, setApiRoot, addLog, listLogs, clearLogs };
