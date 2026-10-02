"use strict";

// Serveur de l'extension OneStock "bo.orders.action".
// - sert les fichiers statiques de ./public
// - expose POST /api/orders/items, qui vérifie la signature de l'extension
//   puis récupère les articles des commandes via l'API OneStock :
//     GET /v3/orders/{id}  -> articles, quantités, prix, états
//     GET /v2/items        -> fiche article (image, et nom/couleur/taille en repli)
// Authentification : token saisi dans l'onglet de config de la pop-up s'il est fourni,
// sinon login avec les identifiants configurés côté serveur.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const config = {
  port: Number(process.env.PORT) || 3000,
  siteId: process.env.ONESTOCK_SITE_ID,
  user: process.env.ONESTOCK_USER,
  password: process.env.ONESTOCK_PASSWORD,
  // Racine de l'API, sans version. Par défaut : https://{site_id}.api.{qualif.}onestock-retail.com
  apiRoot: (process.env.ONESTOCK_API_ROOT || "").replace(/\/$/, ""),
  env: process.env.ONESTOCK_ENV === "prod" ? "prod" : "qualif",
  // Clés secrètes de l'extension (séparées par des virgules : courante, précédente, plus ancienne)
  secretKeys: (process.env.EXTENSION_SECRET_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean),
  // Noms des features produit configurées sur le site OneStock
  features: {
    name: process.env.FEATURE_NAME || "name",
    image: process.env.FEATURE_IMAGE || "image_url",
    color: process.env.FEATURE_COLOR || "color",
    size: process.env.FEATURE_SIZE || "size",
  },
  defaultLang: process.env.DEFAULT_LANG || "en",
  mock: process.env.ONESTOCK_MOCK === "1",
};

const PUBLIC_DIR = path.join(__dirname, "public");
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };

// ---------- Signature de l'extension (cf. doc UI Extensibility) ----------

function checkExtensionSignature(ctx, secretKey) {
  const signature = ctx.extension_signature;
  if (!signature) return false;
  const parts = String(signature).split(",");
  if (parts.length < 2) return false;

  const timestamp = parts[0].replace("t=", "");
  if (Math.floor(Date.now() / 1000) - parseInt(timestamp, 10) > 60 * 60 * 6) return false;

  const expected = crypto.createHmac("sha256", secretKey)
    .update(`${timestamp}.${ctx.extension_id}##${ctx.user_id}`)
    .digest("hex");

  for (let i = 1; i < parts.length; i++) {
    const h = parts[i].replace(`h${i - 1}=`, "");
    if (h.length === expected.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(expected))) return true;
  }
  return false;
}

function isSignatureValid(ctx) {
  if (!config.secretKeys.length) return true; // vérification désactivée (développement)
  return config.secretKeys.some((key) => checkExtensionSignature(ctx, key));
}

// ---------- Client API OneStock ----------

function apiRoot(siteId) {
  if (config.apiRoot) return config.apiRoot;
  return `https://${siteId}.api.${config.env === "prod" ? "" : "qualif."}onestock-retail.com`;
}

// Un client par requête : site_id + token éventuel fourni par la pop-up.
function createClient(siteId, userToken) {
  const root = apiRoot(siteId);
  return { siteId, root, userToken: userToken || null };
}

const loginCache = new Map(); // siteId -> { token, promise }

function login(client) {
  let entry = loginCache.get(client.siteId);
  if (entry && entry.token) return Promise.resolve(entry.token);
  if (entry && entry.promise) return entry.promise;
  if (!config.user || !config.password) {
    return Promise.reject(Object.assign(new Error("Aucun token saisi : renseignez le token API OneStock dans l'onglet Config"), { status: 401 }));
  }
  entry = {};
  entry.promise = (async () => {
    const res = await fetch(`${client.root}/v3/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ site_id: client.siteId, user_id: config.user, password: config.password }),
    });
    if (!res.ok) throw Object.assign(new Error(`Échec du login OneStock (${res.status})`), { status: res.status === 401 ? 401 : 502 });
    entry.token = (await res.json()).token;
    return entry.token;
  })().finally(() => { entry.promise = null; if (!entry.token) loginCache.delete(client.siteId); });
  loginCache.set(client.siteId, entry);
  return entry.promise;
}

// Les GET OneStock portent un body : on utilise POST + X-HTTP-Method-Override: GET.
async function apiGet(client, route, body, retry = true) {
  const token = client.userToken || await login(client);
  const res = await fetch(`${client.root}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-HTTP-Method-Override": "GET" },
    body: JSON.stringify({ ...body, site_id: client.siteId, token }),
  });
  if (res.status === 401) {
    if (client.userToken) throw Object.assign(new Error("Token invalide ou expiré (onglet Config)"), { status: 401 });
    if (retry) {
      loginCache.delete(client.siteId);
      return apiGet(client, route, body, false);
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw Object.assign(new Error(`OneStock ${route} : ${res.status} ${text.slice(0, 300)}`), { status: res.status });
  }
  return res.json();
}

function orderFields() {
  const f = [config.features.name, config.features.color, config.features.size];
  return [
    "id",
    "types",
    "state",
    "order_items._id",
    "order_items.item_id",
    "order_items.quantity",
    "order_items.pricing_details.unit_price",
    "order_items.pricing_details.currency",
    ...f.map((name) => `order_items.item.features.${name}`),
    "line_item_groups.id",
    "line_item_groups.order_item_id",
    "line_item_groups.item_id",
    "line_item_groups.quantity",
    "line_item_groups.state",
    ...f.map((name) => `line_item_groups.item.features.${name}`),
  ];
}

const first = (v) => (Array.isArray(v) ? v[0] : v);

// Fiches articles (GET /v2/items, filtre item_ids) -> Map item_id -> features (langue demandée, sinon la première dispo)
async function getItemSheets(client, itemIds, lang) {
  const ids = [...new Set(itemIds.filter(Boolean))];
  if (!ids.length) return new Map();
  const data = await apiGet(client, "/v2/items", {
    item_ids: ids,
    features: Object.values(config.features),
    lang,
    get_total: false,
    pagination: { start: 0, limit: ids.length },
  });
  const sheets = new Map();
  (data.items || []).forEach((item) => {
    const byLang = item.features || {};
    sheets.set(item.id, byLang[lang] || Object.values(byLang)[0] || {});
  });
  return sheets;
}

// Transforme la commande OneStock en liste d'articles prêts à afficher.
// Une ligne par line_item_group (quantité + état), enrichie du prix de l'order_item
// et de l'image de la fiche article.
function toItems(order, sheets = new Map()) {
  const orderItems = new Map((order.order_items || []).map((oi) => [oi.id || oi._id, oi]));
  const groups = order.line_item_groups && order.line_item_groups.length
    ? order.line_item_groups
    : (order.order_items || []).map((oi) => ({ ...oi, order_item_id: oi.id || oi._id, state: null }));

  return groups.map((g) => {
    const oi = orderItems.get(g.order_item_id) || (order.order_items || []).find((o) => o.item_id === g.item_id) || {};
    const sheet = sheets.get(g.item_id) || {};
    const features = { ...sheet, ...((oi.item && oi.item.features) || {}), ...((g.item && g.item.features) || {}) };
    const pricing = oi.pricing_details || {};
    return {
      item_id: g.item_id,
      name: first(features[config.features.name]) || g.item_id,
      image: first(sheet[config.features.image]) || null,
      color: first(features[config.features.color]) || null,
      size: first(features[config.features.size]) || null,
      unit_price: pricing.unit_price ?? null,
      currency: pricing.currency || null,
      quantity: g.quantity,
      state: g.state,
    };
  });
}

async function getOrderItems(client, orderId, lang) {
  if (config.mock) return mockOrder(orderId);
  const order = await apiGet(client, `/v3/orders/${encodeURIComponent(orderId)}`, {
    fields: orderFields(),
    item_features_lang: lang,
  });
  const itemIds = [...(order.line_item_groups || []), ...(order.order_items || [])].map((x) => x.item_id);
  // Une fiche article indisponible ne doit pas empêcher d'afficher la commande
  const sheets = await getItemSheets(client, itemIds, lang).catch((e) => {
    console.warn(`Fiches articles indisponibles pour ${orderId} : ${e.message}`);
    return new Map();
  });
  return { id: order.id || orderId, types: order.types || [], state: order.state, items: toItems(order, sheets) };
}

function mockOrder(orderId) {
  return {
    id: orderId,
    types: ["online"],
    state: "fulfilled",
    items: [
      { item_id: "1006199107161", name: "Bonnet", image: null, color: "Marron", size: "1-size", unit_price: 7.99, currency: "EUR", quantity: 1, state: "claimed" },
      { item_id: "1006199107178", name: "Écharpe", image: null, color: "Gris", size: "1-size", unit_price: 19.99, currency: "EUR", quantity: 2, state: "fulfilled" },
    ],
  };
}

// ---------- HTTP ----------

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

async function handleOrderItems(req, res) {
  let body;
  try { body = await readJson(req); } catch (e) { return sendJson(res, 400, { error: "JSON invalide" }); }

  if (!isSignatureValid(body)) return sendJson(res, 401, { error: "Signature d'extension invalide" });

  const ids = (Array.isArray(body.order_ids) ? body.order_ids : String(body.order_ids || "").split(","))
    .map((s) => String(s).trim()).filter(Boolean).slice(0, 50);
  if (!ids.length) return sendJson(res, 400, { error: "Aucune commande (order_ids)" });

  // site_id : celui du serveur s'il est configuré, sinon celui transmis par OneStock (paramètre d'URL)
  const siteId = config.siteId || body.site_id;
  if (!config.mock && !/^[a-z0-9_-]{1,32}$/i.test(siteId || "")) return sendJson(res, 400, { error: "site_id manquant ou invalide" });

  const token = typeof body.api_token === "string" ? body.api_token.trim() : "";
  if (token && !/^[\w.+/=-]{1,512}$/.test(token)) return sendJson(res, 400, { error: "Format de token invalide" });

  const lang = /^[a-z]{2}([_-][A-Za-z]{2})?$/.test(body.lang || "") ? body.lang.slice(0, 2) : config.defaultLang;
  const client = createClient(siteId, token);

  const orders = await Promise.all(ids.map((id) =>
    getOrderItems(client, id, lang).catch((e) => ({ id, error: e.message, auth_error: e.status === 401 }))));
  sendJson(res, 200, { orders });
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.normalize(path.join(PUBLIC_DIR, urlPath === "/" ? "index.html" : urlPath));
  if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendJson(res, 403, { error: "Interdit" });
  fs.readFile(file, (err, content) => {
    if (err) return sendJson(res, 404, { error: "Introuvable" });
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url.split("?")[0] === "/api/orders/items") {
    return handleOrderItems(req, res).catch((e) => sendJson(res, 500, { error: e.message }));
  }
  if (req.method === "GET") return serveStatic(req, res);
  sendJson(res, 405, { error: "Méthode non autorisée" });
});

if (require.main === module) {
  if (!config.mock && (!config.user || !config.password)) {
    console.warn("ℹ ONESTOCK_USER / ONESTOCK_PASSWORD non définis : seul le token saisi dans l'onglet Config sera utilisé.");
  }
  if (!config.secretKeys.length) console.warn("⚠ EXTENSION_SECRET_KEYS non défini : la signature de l'extension n'est pas vérifiée.");
  server.listen(config.port, () => console.log(`Extension disponible sur http://localhost:${config.port}`));
}

module.exports = { server, checkExtensionSignature, toItems, orderFields };
