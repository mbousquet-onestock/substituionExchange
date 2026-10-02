"use strict";

// Accès à la base Postgres (Vercel Storage → Neon, ou tout Postgres).
// Variables lues : POSTGRES_URL ou DATABASE_URL.
// Tables :
//   settings (site_id, key, value) : configuration par site (token, route de l'API, langue par défaut).
//            site_id = '' : valeurs communes à tous les sites (repli).
//   api_logs : journal des appels API OneStock (avec le site_id).

const { Pool } = require("pg");

const MAX_LOGS = 500;
const SETTING_KEYS = { token: "onestock_token", api_root: "onestock_api_root", default_lang: "default_lang" };
let pool = null;
let schemaReady = null;

function connectionString() {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL || "";
}

function getPool() {
  if (!pool) {
    const url = connectionString();
    if (!url) throw Object.assign(new Error("Base de données non configurée (POSTGRES_URL ou DATABASE_URL)"), { status: 500, code: "db_not_configured" });
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
        site_id    text NOT NULL DEFAULT '',
        key        text NOT NULL,
        value      text NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (site_id, key)
      );
      -- Migration de l'ancienne table settings (clé unique, sans site_id) : les valeurs existantes
      -- deviennent les valeurs communes (site_id = '')
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = 'site_id') THEN
          ALTER TABLE settings ADD COLUMN site_id text NOT NULL DEFAULT '';
          ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
          ALTER TABLE settings ADD PRIMARY KEY (site_id, key);
        END IF;
      END $$;
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
      ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS site_id text;
      CREATE INDEX IF NOT EXISTS api_logs_created_at_idx ON api_logs (created_at DESC);
    `).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

async function query(sql, params) {
  await ensureSchema();
  return getPool().query(sql, params);
}

// ---------- Paramètres par site ----------

// Paramètres d'un site : { token, api_root, default_lang } avec, pour chacun, la valeur du site
// ou à défaut la valeur commune (site_id = ''). updated_at / inherited par champ.
async function getSiteSettings(siteId) {
  const { rows } = await query(
    "SELECT site_id, key, value, updated_at FROM settings WHERE site_id = $1 OR site_id = '' ORDER BY site_id DESC",
    [siteId || ""]
  );
  const result = {};
  Object.entries(SETTING_KEYS).forEach(([name, key]) => {
    const row = rows.find((r) => r.key === key); // la ligne du site passe avant la ligne commune (ORDER BY DESC)
    result[name] = row ? { value: row.value, updated_at: row.updated_at, inherited: row.site_id !== (siteId || "") } : null;
  });
  return result;
}

// changes : { token?, api_root?, default_lang? } ; valeur vide = suppression (retour à la valeur commune / par défaut)
async function setSiteSettings(siteId, changes) {
  for (const [name, key] of Object.entries(SETTING_KEYS)) {
    if (changes[name] === undefined) continue;
    if (!changes[name]) {
      await query("DELETE FROM settings WHERE site_id = $1 AND key = $2", [siteId || "", key]);
    } else {
      await query(
        `INSERT INTO settings (site_id, key, value, updated_at) VALUES ($1, $2, $3, now())
         ON CONFLICT (site_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [siteId || "", key, changes[name]]
      );
    }
  }
}

// Crée les lignes manquantes route de l'API / langue par défaut d'un site, avec la valeur commune
// (site_id = '') ou à défaut la valeur par défaut. Les lignes existantes ne sont pas modifiées.
async function ensureSiteDefaults(siteId, defaults) {
  await query(
    `INSERT INTO settings (site_id, key, value)
     SELECT $1, k.key, COALESCE((SELECT c.value FROM settings c WHERE c.site_id = '' AND c.key = k.key), k.def)
     FROM (VALUES ($2::text, $3::text), ($4::text, $5::text)) AS k(key, def)
     ON CONFLICT (site_id, key) DO NOTHING`,
    [siteId || "", SETTING_KEYS.api_root, defaults.api_root, SETTING_KEYS.default_lang, defaults.default_lang]
  );
}

// Sites ayant une configuration ('' = valeurs communes)
async function listSites() {
  const { rows } = await query("SELECT site_id, max(updated_at) AS updated_at FROM settings GROUP BY site_id ORDER BY site_id");
  return rows;
}

// ---------- Journal des appels API ----------

async function addLog(entry) {
  await query(
    `INSERT INTO api_logs (site_id, method, url, request, status, duration_ms, response, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [entry.site_id ?? null, entry.method, entry.url, entry.request ? JSON.stringify(entry.request) : null, entry.status ?? null,
      entry.duration_ms ?? null, entry.response ?? null, entry.error ?? null]
  );
  // On ne garde que les MAX_LOGS derniers appels
  await query(`DELETE FROM api_logs WHERE id <= (SELECT id FROM api_logs ORDER BY id DESC OFFSET $1 LIMIT 1)`, [MAX_LOGS]);
}

// siteId vide = tous les sites
async function listLogs(limit = 100, siteId) {
  const { rows } = await query(
    `SELECT id, created_at, site_id, method, url, request, status, duration_ms, response, error
     FROM api_logs WHERE ($2::text IS NULL OR site_id = $2) ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), MAX_LOGS), siteId || null]
  );
  return rows;
}

async function clearLogs(siteId) {
  if (siteId) await query("DELETE FROM api_logs WHERE site_id = $1", [siteId]);
  else await query("DELETE FROM api_logs");
}

module.exports = { getSiteSettings, setSiteSettings, ensureSiteDefaults, listSites, addLog, listLogs, clearLogs };
