"use strict";

// Proxy vers les API OneStock.
// - token et route de l'API lus en base pour le site (page /config.html), jamais exposés au navigateur
// - site_id et token sont injectés dans le body de chaque appel
// - chaque appel est journalisé en base (table api_logs), token masqué

const db = require("./db");

// Identifiant de cette extension dans la table settings (partagée entre applicatifs)
const EXTENSION_ID = (process.env.EXTENSION_ID || "substitution").trim();
// Environnements OneStock acceptés et environnement par défaut
const ENVIRONMENTS = (process.env.ONESTOCK_ENVIRONMENTS || "qualif,prod").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const DEFAULT_ENV = (process.env.ONESTOCK_ENV || ENVIRONMENTS[0] || "qualif").toLowerCase();
db.setLegacyEnvironment(DEFAULT_ENV);
// Route de l'API par défaut par environnement (modifiable par site dans /config.html ; ONESTOCK_API_ROOT force la valeur)
const ENV_API_ROOTS = { qualif: "https://api-qualif.onestock-retail.com", prod: "https://api.onestock-retail.com" };
function defaultApiRoot(env) {
  return (process.env.ONESTOCK_API_ROOT || ENV_API_ROOTS[env] || ENV_API_ROOTS.qualif).replace(/\/+$/, "");
}
const DEFAULT_API_ROOT = defaultApiRoot(DEFAULT_ENV);
// Statuts de ligne de commande permettant la substitution : "*" = tous
const DEFAULT_SUBSTITUTION_STATES = process.env.DEFAULT_SUBSTITUTION_STATES || "*";
// Transport des GET avec body : "xget" (recommandé par la doc OneStock) ou "override" (POST + X-HTTP-Method-Override)
const GET_TRANSPORT = process.env.ONESTOCK_GET_TRANSPORT === "override" ? "override" : "xget";
const MAX_LOGGED_RESPONSE = 4000;
// Langue par défaut (repli des fiches articles) si non configurée pour le site
const DEFAULT_LANG = (process.env.DEFAULT_LANG || "fr").toLowerCase();

// Routes autorisées via le proxy (lecture seule)
const ALLOWED = [
  { method: "GET", pattern: /^\/v[1-4]\/orders\/[^/?#]+$/ },
  { method: "GET", pattern: /^\/v[1-4]\/items$/ },
  { method: "GET", pattern: /^\/v[1-4]\/line_item_groups$/ },
];

// Noms des features produit configurées sur le site OneStock
const FEATURES = {
  name: process.env.FEATURE_NAME || "name",
  color: process.env.FEATURE_COLOR || "color",
  size: process.env.FEATURE_SIZE || "size",
};

// Champs demandés à GET /v3/orders/{id}
function orderFields() {
  const f = [FEATURES.name, FEATURES.color, FEATURES.size];
  return [
    "id", "types", "state",
    "order_items._id", "order_items.item_id", "order_items.quantity",
    "order_items.pricing_details.unit_price", "order_items.pricing_details.currency",
    ...f.map((n) => `order_items.item.features.${n}`),
    "line_item_groups.id", "line_item_groups.order_item_id", "line_item_groups.item_id",
    "line_item_groups.quantity", "line_item_groups.state",
    ...f.map((n) => `line_item_groups.item.features.${n}`),
  ];
}

// Normalise et valide une route d'API saisie dans la config.
// Le token y étant envoyé, seules les URL https en *.onestock-retail.com sont acceptées.
function normalizeApiRoot(value) {
  let url;
  try { url = new URL(String(value).trim()); } catch (e) { return null; }
  if (url.protocol !== "https:" || !/(^|\.)onestock-retail\.com$/i.test(url.hostname)) return null;
  if (url.search || url.hash || url.username || url.password) return null;
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}

function normalizeLang(value) {
  const v = String(value || "").trim().toLowerCase();
  return /^[a-z]{2}$/.test(v) ? v : null;
}

// Statuts : liste séparée par des virgules ("*" = tous) -> tableau normalisé, ou null si invalide
function normalizeStates(value) {
  const list = String(value || "").split(/[,;\s]+/).map((v) => v.trim()).filter(Boolean);
  if (!list.length) return [];
  if (list.includes("*")) return ["*"];
  return list.every((v) => /^[\w.-]{1,64}$/.test(v)) ? [...new Set(list)] : null;
}

function resolveEnv(requested) {
  const env = String(requested || "").trim().toLowerCase();
  if (!env) return DEFAULT_ENV;
  if (!ENVIRONMENTS.includes(env)) {
    throw Object.assign(new Error(`Environnement inconnu : ${env}`), { status: 400, code: "env_invalid", vars: { env } });
  }
  return env;
}

// Contexte de configuration : { extension_id, environment, site_id }
function context(siteId, env) {
  return { extension_id: EXTENSION_ID, environment: resolveEnv(env), site_id: siteId || "" };
}

function defaultsFor(env) {
  return { api_root: defaultApiRoot(env), default_lang: DEFAULT_LANG, substitution_states: DEFAULT_SUBSTITUTION_STATES };
}

// Contextes dont les lignes par défaut ont déjà été créées (par instance)
const seeded = new Set();

// Garantit la présence en base des paramètres par défaut du site (route, langue, statuts)
async function ensureSiteDefaults(ctx, force) {
  const id = `${ctx.extension_id}|${ctx.environment}|${ctx.site_id}`;
  if (!force && seeded.has(id)) return;
  await db.ensureDefaults(ctx, defaultsFor(ctx.environment));
  seeded.add(id);
}

// Configuration effective d'un site (extension > global, site > commun, sinon valeur par défaut)
async function siteConfig(siteId, env) {
  const ctx = context(siteId, env);
  await ensureSiteDefaults(ctx);
  const s = await db.getSettings(ctx);
  const d = defaultsFor(ctx.environment);
  return {
    ctx,
    token: s.token && s.token.value,
    api_root: (s.api_root && s.api_root.value) || d.api_root,
    default_lang: (s.default_lang && s.default_lang.value) || d.default_lang,
    substitution_states: normalizeStates((s.substitution_states && s.substitution_states.value) || d.substitution_states) || ["*"],
    raw: s,
  };
}

function resolveSiteId(requested) {
  const siteId = process.env.ONESTOCK_SITE_ID || requested;
  if (!/^[a-z0-9_-]{1,32}$/i.test(siteId || "")) {
    throw Object.assign(new Error("site_id manquant ou invalide"), { status: 400, code: "site_id_invalid" });
  }
  return siteId;
}

function isAllowed(method, path) {
  return ALLOWED.some((r) => r.method === method && r.pattern.test(path));
}

function redact(body) {
  if (!body || typeof body !== "object") return body;
  return { ...body, ...(body.token ? { token: "***" } : {}) };
}

async function safeLog(entry) {
  try {
    await db.addLog(entry);
  } catch (e) {
    console.error("Journalisation impossible :", e.message);
  }
}

// Appelle OneStock et renvoie { status, data } tel que reçu.
async function call({ method, path, body, siteId, env }) {
  method = String(method || "GET").toUpperCase();
  if (typeof path !== "string" || !isAllowed(method, path)) {
    throw Object.assign(new Error(`Route non autorisée par le proxy : ${method} ${path}`), { status: 403, code: "route_forbidden", vars: { route: `${method} ${path}` } });
  }
  siteId = resolveSiteId(siteId);

  const cfg = await siteConfig(siteId, env);
  if (!cfg.token) throw Object.assign(new Error(`Aucun token enregistré pour le site ${siteId} : renseignez-le dans la page de configuration (/config.html)`), { status: 401, auth: true, code: "token_missing", vars: { site_id: siteId } });

  const url = `${cfg.api_root}${path}`;
  const payload = { ...(body || {}), site_id: siteId, token: cfg.token };
  const headers = { "Content-Type": "application/json", Accept: "application/json" };
  let httpMethod = method;
  if (method === "GET") {
    if (GET_TRANSPORT === "override") {
      httpMethod = "POST";
      headers["X-HTTP-Method-Override"] = "GET";
    } else {
      httpMethod = "XGET";
    }
  }

  const started = Date.now();
  const log = { extension_id: cfg.ctx.extension_id, environment: cfg.ctx.environment, site_id: siteId, method: httpMethod === method ? method : `${method} (${httpMethod})`, url, request: redact(payload) };
  let res;
  let text;
  try {
    res = await fetch(url, { method: httpMethod, headers, body: JSON.stringify(payload) });
    text = await res.text();
  } catch (e) {
    const reason = e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message;
    await safeLog({ ...log, duration_ms: Date.now() - started, error: reason });
    throw Object.assign(new Error(`Appel OneStock impossible : ${reason}`), { status: 502, code: "network", vars: { reason } });
  }

  await safeLog({
    ...log,
    status: res.status,
    duration_ms: Date.now() - started,
    response: text.length > MAX_LOGGED_RESPONSE ? `${text.slice(0, MAX_LOGGED_RESPONSE)}…` : text,
  });

  let data;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = { raw: text.slice(0, 1000) }; }
  return { status: res.status, data };
}

module.exports = {
  call, isAllowed, siteConfig, ensureSiteDefaults, context, defaultsFor, resolveSiteId, resolveEnv,
  normalizeApiRoot, normalizeLang, normalizeStates, orderFields,
  EXTENSION_ID, ENVIRONMENTS, DEFAULT_ENV, DEFAULT_API_ROOT, DEFAULT_LANG,
};
