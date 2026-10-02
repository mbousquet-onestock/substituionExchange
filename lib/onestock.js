"use strict";

// Proxy vers les API OneStock.
// - le token est lu en base (saisi dans l'onglet Config), jamais exposé au navigateur
// - site_id et token sont injectés dans le body de chaque appel
// - chaque appel est journalisé en base (table api_logs), token masqué

const db = require("./db");

const ENV = process.env.ONESTOCK_ENV === "prod" ? "prod" : "qualif";
// Transport des GET avec body : "xget" (recommandé par la doc OneStock) ou "override" (POST + X-HTTP-Method-Override)
const GET_TRANSPORT = process.env.ONESTOCK_GET_TRANSPORT === "override" ? "override" : "xget";
const MAX_LOGGED_RESPONSE = 4000;

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

function apiRoot(siteId) {
  const root = (process.env.ONESTOCK_API_ROOT || "").replace(/\/$/, "");
  if (root) return root;
  return `https://${siteId}.api.${ENV === "prod" ? "" : "qualif."}onestock-retail.com`;
}

function resolveSiteId(requested) {
  const siteId = process.env.ONESTOCK_SITE_ID || requested;
  if (!/^[a-z0-9_-]{1,32}$/i.test(siteId || "")) {
    throw Object.assign(new Error("site_id manquant ou invalide"), { status: 400 });
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
async function call({ method, path, body, siteId }) {
  method = String(method || "GET").toUpperCase();
  if (typeof path !== "string" || !isAllowed(method, path)) {
    throw Object.assign(new Error(`Route non autorisée par le proxy : ${method} ${path}`), { status: 403 });
  }
  siteId = resolveSiteId(siteId);

  const stored = await db.getToken();
  if (!stored) throw Object.assign(new Error("Aucun token enregistré : renseignez le token API OneStock dans l'onglet Config"), { status: 401, auth: true });

  const url = `${apiRoot(siteId)}${path}`;
  const payload = { ...(body || {}), site_id: siteId, token: stored.token };
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
  const log = { method: httpMethod === method ? method : `${method} (${httpMethod})`, url, request: redact(payload) };
  let res;
  let text;
  try {
    res = await fetch(url, { method: httpMethod, headers, body: JSON.stringify(payload) });
    text = await res.text();
  } catch (e) {
    const reason = e.cause ? `${e.message} (${e.cause.code || e.cause.message})` : e.message;
    await safeLog({ ...log, duration_ms: Date.now() - started, error: reason });
    throw Object.assign(new Error(`Appel OneStock impossible : ${reason}`), { status: 502 });
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

module.exports = { call, isAllowed, apiRoot, orderFields };
