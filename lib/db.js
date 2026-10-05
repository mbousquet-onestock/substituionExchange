"use strict";

// Accès à la base Postgres (Vercel Storage → Neon, ou tout Postgres).
// Variables lues : POSTGRES_URL ou DATABASE_URL.
//
// Table settings, partagée entre plusieurs applicatifs. Chaque ligne est identifiée par :
//   extension_id : id de l'extension ("substitution"), ou "*" pour un paramètre global à toutes les extensions
//   environment  : environnement OneStock (qualif, prod…)
//   site_id      : site OneStock, ou "" pour la valeur commune à tous les sites
//   key          : nom du paramètre
// La colonne calculée scope vaut "global" (extension_id = "*") ou "extension".
//
// Résolution d'un paramètre pour (extension, environnement, site), du plus précis au plus général :
//   extension + site  >  global + site  >  extension + commun  >  global + commun  >  valeur par défaut
//
// Table api_logs : journal des appels API OneStock (extension, environnement, site).

const { Pool } = require("pg");

const MAX_LOGS = 500;
const GLOBAL = "*";

// Paramètres connus : clé en base et portée par défaut (à l'écriture et à la création automatique)
const PARAMS = {
  token: { key: "onestock_token", scope: "global" },
  api_root: { key: "onestock_api_root", scope: "global" },
  default_lang: { key: "default_lang", scope: "global" },
  substitution_states: { key: "substitution_states", scope: "extension" },
  substituted_state: { key: "substituted_state", scope: "extension" },
};

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

// legacyEnv : environnement attribué aux lignes existantes lors de la migration
function ensureSchema(legacyEnv) {
  if (!schemaReady) {
    const env = /^[a-z0-9_-]{1,20}$/.test(legacyEnv || "") ? legacyEnv : "qualif";
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS settings (
        extension_id text NOT NULL DEFAULT '${GLOBAL}',
        environment  text NOT NULL,
        site_id      text NOT NULL DEFAULT '',
        key          text NOT NULL,
        value        text NOT NULL,
        scope        text GENERATED ALWAYS AS (CASE WHEN extension_id = '${GLOBAL}' THEN 'global' ELSE 'extension' END) STORED,
        updated_at   timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (extension_id, environment, site_id, key)
      );
      DO $$
      BEGIN
        -- Migration 1 : ancienne table (clé seule) -> ajout de site_id
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = 'site_id') THEN
          ALTER TABLE settings ADD COLUMN site_id text NOT NULL DEFAULT '';
        END IF;
        -- Migration 2 : ajout de extension_id (lignes existantes = globales), environment et scope
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                       WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name = 'environment') THEN
          ALTER TABLE settings ADD COLUMN extension_id text NOT NULL DEFAULT '${GLOBAL}';
          ALTER TABLE settings ADD COLUMN environment text NOT NULL DEFAULT '${env}';
          ALTER TABLE settings ALTER COLUMN environment DROP DEFAULT;
          ALTER TABLE settings ADD COLUMN scope text
            GENERATED ALWAYS AS (CASE WHEN extension_id = '${GLOBAL}' THEN 'global' ELSE 'extension' END) STORED;
          ALTER TABLE settings DROP CONSTRAINT IF EXISTS settings_pkey;
          ALTER TABLE settings ADD PRIMARY KEY (extension_id, environment, site_id, key);
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
      ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS extension_id text;
      ALTER TABLE api_logs ADD COLUMN IF NOT EXISTS environment text;
      CREATE INDEX IF NOT EXISTS api_logs_created_at_idx ON api_logs (created_at DESC);
    `).catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

let legacyEnv = "qualif";
function setLegacyEnvironment(env) { legacyEnv = env; }

async function query(sql, params) {
  await ensureSchema(legacyEnv);
  return getPool().query(sql, params);
}

// ---------- Paramètres ----------
// ctx : { extension_id, environment, site_id }

// Rang d'une ligne (plus petit = plus précis)
function rank(row, ctx) {
  const site = row.site_id === (ctx.site_id || "") ? 0 : 2;
  const ext = row.extension_id === ctx.extension_id ? 0 : 1;
  return site + ext;
}

// Valeur effective de chaque paramètre : { name: { value, updated_at, scope, level } | null }
//   scope : "global" | "extension" ; level : "site" | "common"
async function getSettings(ctx) {
  const { rows } = await query(
    `SELECT extension_id, site_id, key, value, scope, updated_at FROM settings
     WHERE environment = $1 AND extension_id IN ($2, '${GLOBAL}') AND site_id IN ($3, '')`,
    [ctx.environment, ctx.extension_id, ctx.site_id || ""]
  );
  const result = {};
  Object.entries(PARAMS).forEach(([name, p]) => {
    const row = rows.filter((r) => r.key === p.key).sort((a, b) => rank(a, ctx) - rank(b, ctx))[0];
    result[name] = row
      ? { value: row.value, updated_at: row.updated_at, scope: row.scope, level: row.site_id === (ctx.site_id || "") ? "site" : "common" }
      : null;
  });
  return result;
}

// changes : { name: { value, scope? } } pour le site de ctx.
//   scope "global" : écrit la ligne globale et supprime la ligne propre à l'extension (qui la masquerait)
//   scope "extension" : écrit la ligne propre à l'extension (la ligne globale reste pour les autres extensions)
//   valeur vide : supprime la ligne de la portée choisie
async function setSettings(ctx, changes) {
  for (const [name, change] of Object.entries(changes)) {
    const p = PARAMS[name];
    if (!p || !change) continue;
    const scope = change.scope === "global" || change.scope === "extension" ? change.scope : p.scope;
    const ext = scope === "global" ? GLOBAL : ctx.extension_id;
    const site = ctx.site_id || "";
    if (scope === "global") {
      await query("DELETE FROM settings WHERE extension_id = $1 AND environment = $2 AND site_id = $3 AND key = $4",
        [ctx.extension_id, ctx.environment, site, p.key]);
    }
    if (!change.value) {
      await query("DELETE FROM settings WHERE extension_id = $1 AND environment = $2 AND site_id = $3 AND key = $4",
        [ext, ctx.environment, site, p.key]);
    } else {
      await query(
        `INSERT INTO settings (extension_id, environment, site_id, key, value, updated_at) VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (extension_id, environment, site_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [ext, ctx.environment, site, p.key, change.value]
      );
    }
  }
}

// Crée, pour le site, les paramètres sans aucune ligne (ni globale ni propre à l'extension) au niveau du site,
// dans leur portée par défaut, avec la valeur commune ou à défaut la valeur par défaut.
// defaults : { name: valeur par défaut } (les paramètres absents de defaults ne sont pas créés).
async function ensureDefaults(ctx, defaults) {
  for (const [name, def] of Object.entries(defaults)) {
    const p = PARAMS[name];
    if (!p || def === undefined || def === null || def === "") continue;
    const ext = p.scope === "global" ? GLOBAL : ctx.extension_id;
    await query(
      `INSERT INTO settings (extension_id, environment, site_id, key, value)
       SELECT $1, $2, $3, $4, COALESCE(
         (SELECT c.value FROM settings c
          WHERE c.environment = $2 AND c.site_id = '' AND c.key = $4 AND c.extension_id IN ($6, '${GLOBAL}')
          ORDER BY (c.extension_id = $6) DESC LIMIT 1),
         $5)
       WHERE NOT EXISTS (SELECT 1 FROM settings s
                         WHERE s.environment = $2 AND s.site_id = $3 AND s.key = $4 AND s.extension_id IN ($6, '${GLOBAL}'))
       ON CONFLICT DO NOTHING`,
      [ext, ctx.environment, ctx.site_id || "", p.key, String(def), ctx.extension_id]
    );
  }
}

// Sites configurés pour l'extension (ou en global) dans un environnement ('' = valeurs communes)
async function listSites(ctx) {
  const { rows } = await query(
    `SELECT site_id, max(updated_at) AS updated_at FROM settings
     WHERE environment = $1 AND extension_id IN ($2, '${GLOBAL}') GROUP BY site_id ORDER BY site_id`,
    [ctx.environment, ctx.extension_id]
  );
  return rows;
}

// Environnements présents en base
async function listEnvironments() {
  const { rows } = await query("SELECT DISTINCT environment FROM settings ORDER BY environment");
  return rows.map((r) => r.environment);
}

// ---------- Journal des appels API ----------

async function addLog(entry) {
  await query(
    `INSERT INTO api_logs (extension_id, environment, site_id, method, url, request, status, duration_ms, response, error)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [entry.extension_id ?? null, entry.environment ?? null, entry.site_id ?? null, entry.method, entry.url,
      entry.request ? JSON.stringify(entry.request) : null, entry.status ?? null,
      entry.duration_ms ?? null, entry.response ?? null, entry.error ?? null]
  );
  // On ne garde que les MAX_LOGS derniers appels
  await query(`DELETE FROM api_logs WHERE id <= (SELECT id FROM api_logs ORDER BY id DESC OFFSET $1 LIMIT 1)`, [MAX_LOGS]);
}

// filter : { extension_id?, environment?, site_id? } (critère absent = pas de filtre)
async function listLogs(limit = 100, filter = {}) {
  const { rows } = await query(
    `SELECT id, created_at, extension_id, environment, site_id, method, url, request, status, duration_ms, response, error
     FROM api_logs
     WHERE ($2::text IS NULL OR extension_id = $2) AND ($3::text IS NULL OR environment = $3) AND ($4::text IS NULL OR site_id = $4)
     ORDER BY id DESC LIMIT $1`,
    [Math.min(Math.max(Number(limit) || 100, 1), MAX_LOGS), filter.extension_id || null, filter.environment || null, filter.site_id || null]
  );
  return rows;
}

async function clearLogs(filter = {}) {
  await query(
    `DELETE FROM api_logs
     WHERE ($1::text IS NULL OR extension_id = $1) AND ($2::text IS NULL OR environment = $2) AND ($3::text IS NULL OR site_id = $3)`,
    [filter.extension_id || null, filter.environment || null, filter.site_id || null]
  );
}

// Diagnostic : base utilisée, structure de settings et lignes d'un contexte
async function diagnostic(ctx) {
  let database = null;
  try {
    const u = new URL(connectionString());
    database = { host: u.hostname, database: u.pathname.replace(/^\//, ""), user: u.username };
  } catch (e) { database = { error: "URL de connexion illisible" }; }
  const info = await query("SELECT current_database() AS db, current_schema() AS schema, version() AS version");
  const cols = await query(
    `SELECT column_name, data_type, is_nullable, column_default, is_generated FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'settings' ORDER BY ordinal_position`);
  const pk = await query(
    `SELECT a.attname AS column FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
     WHERE i.indrelid = 'settings'::regclass AND i.indisprimary`);
  const rows = await query(
    `SELECT extension_id, environment, site_id, key, value, scope, updated_at FROM settings
     WHERE environment = $1 AND site_id IN ($2, '') ORDER BY site_id, key, extension_id`,
    [ctx.environment, ctx.site_id || ""]);
  const counts = await query("SELECT environment, key, count(*)::int AS rows FROM settings GROUP BY 1, 2 ORDER BY 1, 2");
  return {
    database: { ...database, current_database: info.rows[0].db, schema: info.rows[0].schema, version: info.rows[0].version },
    columns: cols.rows, primary_key: pk.rows.map((r) => r.column),
    rows: rows.rows.map((r) => (r.key === PARAMS.token.key ? { ...r, value: "***" } : r)),
    counts: counts.rows,
  };
}

module.exports = {
  diagnostic,
  PARAMS, GLOBAL, setLegacyEnvironment,
  getSettings, setSettings, ensureDefaults, listSites, listEnvironments,
  addLog, listLogs, clearLogs,
};
