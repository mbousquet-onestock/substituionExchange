"use strict";

// POST /api/admin/config  (en-tête X-Admin-Key)
// { action: "meta" }                     -> { extension_id, environments, default_env, params }
// { action: "diagnostic", env, site_id, order_id? } -> déploiement, base utilisée, structure et lignes de settings,
//   empreinte du token (stocké / déchiffré) et appel test à OneStock avec ce token
// { action: "sites", env }               -> { sites: [{ site_id, updated_at }] }
// { action: "get", env, site_id }        -> configuration du site
// { action: "set", env, site_id, params: { api_root?, default_lang?, substitution_states?, substituted_state?, api_logs?, token? } }
//   chaque paramètre : { value, scope: "global" | "extension" }
//   global = valable pour toutes les extensions (extension_id "*"), extension = propre à cette extension.
//   route / langue / statuts vides : retour à la valeur commune puis par défaut (réenregistrée pour le site) ;
//   token vide : suppression.
// site_id "" = valeurs communes à tous les sites de l'environnement.

const { adminEndpoint } = require("../../lib/http");
const db = require("../../lib/db");
const onestock = require("../../lib/onestock");
const secret = require("../../lib/secret");

function preview(token) {
  return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "****";
}

function checkSiteId(siteId) {
  const id = typeof siteId === "string" ? siteId.trim() : "";
  if (id && !/^[a-z0-9_-]{1,32}$/i.test(id)) throw Object.assign(new Error("site_id invalide"), { status: 400, code: "site_id_invalid" });
  return id;
}

function bad(code, error) {
  return Object.assign(new Error(error), { status: 400, code });
}

// Validation / normalisation de la valeur d'un paramètre ("" = suppression)
function normalize(name, raw) {
  const v = String(raw == null ? "" : raw).trim();
  if (!v) return "";
  if (name === "api_root") {
    const root = onestock.normalizeApiRoot(v);
    if (root === null) throw bad("invalid_api_root", "Route de l'API invalide : URL https en *.onestock-retail.com attendue (ex. https://api-qualif.onestock-retail.com)");
    return root;
  }
  if (name === "default_lang") {
    const lang = onestock.normalizeLang(v);
    if (lang === null) throw bad("invalid_lang", "Langue invalide : code à 2 lettres attendu (ex. fr)");
    return lang;
  }
  if (name === "substitution_states") {
    const states = onestock.normalizeStates(v);
    if (states === null) throw bad("invalid_states", "Statuts invalides : liste séparée par des virgules (ex. fulfilled, claimed) ou * pour tous");
    return states.join(",");
  }
  if (name === "substituted_state") {
    const state = onestock.normalizeState(v);
    if (state === null) throw bad("invalid_state", "Statut invalide (ex. substituted)");
    return state;
  }
  if (name === "api_logs") {
    const v2 = onestock.normalizeOnOff(v);
    if (v2 === null) throw bad("invalid_on_off", "Valeur invalide : on ou off");
    return v2;
  }
  if (name === "token") {
    if (!/^[\w.+/=-]{1,1024}$/.test(v)) throw bad("invalid_token_format", "Format de token invalide");
    return secret.encrypt(v); // chiffré avec SETTINGS_ENCRYPTION_KEY si elle est définie
  }
  return v;
}

// Aperçu du token déchiffré (jamais la valeur complète) et état du déchiffrement
function tokenPreview(stored) {
  try {
    const d = secret.decrypt(stored);
    return { preview: preview(d.value), encrypted: !!d.format, format: d.format || undefined };
  } catch (e) {
    return { preview: "****", decrypt_error: e.message };
  }
}

async function describe(ctx) {
  // Paramètres par défaut toujours présents en base pour le site
  await onestock.ensureSiteDefaults(ctx, true);
  const s = await db.getSettings(ctx);
  const defaults = onestock.defaultsFor(ctx.environment);
  const field = (name) => {
    const f = s[name];
    return f
      ? { value: f.value, updated_at: f.updated_at, scope: f.scope, level: f.level }
      : { value: defaults[name], updated_at: null, scope: db.PARAMS[name].scope, level: "default" };
  };
  return {
    extension_id: ctx.extension_id,
    environment: ctx.environment,
    site_id: ctx.site_id,
    token: s.token
      ? { set: true, ...tokenPreview(s.token.value), updated_at: s.token.updated_at, scope: s.token.scope, level: s.token.level, row: s.token.row }
      : { set: false, scope: db.PARAMS.token.scope },
    api_root: field("api_root"),
    default_lang: field("default_lang"),
    substitution_states: field("substitution_states"),
    substituted_state: field("substituted_state"),
    api_logs: field("api_logs"),
    defaults,
  };
}

module.exports = adminEndpoint(async (req) => {
  if (req.action === "meta") {
    return { data: {
      extension_id: onestock.EXTENSION_ID,
      environments: onestock.ENVIRONMENTS,
      default_env: onestock.DEFAULT_ENV,
      params: Object.fromEntries(Object.entries(db.PARAMS).map(([k, p]) => [k, { key: p.key, scope: p.scope }])),
    } };
  }
  const ctx = onestock.context(checkSiteId(req.site_id), req.env);
  if (req.action === "diagnostic") {
    // Force la création des lignes par défaut et rapporte l'éventuelle erreur
    let seed = { ok: true };
    let token = null;
    try {
      const cfg = await onestock.siteConfig(ctx.site_id, ctx.environment);
      if (cfg.token_stored) {
        token = { found: true, row: cfg.raw.token && cfg.raw.token.row, stored: secret.fingerprint(cfg.token_stored) };
        try {
          const d = secret.decrypt(cfg.token_stored);
          token = { ...token, encrypted: !!d.format, format: d.format, decrypted: true, value: secret.fingerprint(d.value) };
        } catch (e) { token = { ...token, decrypted: false, error: e.message }; }
        // Appel test à OneStock avec ce token (commande donnée, sinon une fiche article)
        if (token.decrypted && ctx.site_id) {
          const path = req.order_id ? `/v3/orders/${encodeURIComponent(String(req.order_id).trim())}` : "/v2/items";
          const body = req.order_id ? { fields: ["id", "state"] } : { get_total: false, pagination: { start: 0, limit: 1 } };
          try {
            const r = await onestock.call({ method: "GET", path, body, siteId: ctx.site_id, env: ctx.environment });
            token.test = { request: `GET ${cfg.api_root}${path}`, site_id: ctx.site_id, status: r.status,
              ok: r.status >= 200 && r.status < 300, response: r.status >= 300 ? r.data : "OK" };
          } catch (e) { token.test = { request: `GET ${cfg.api_root}${path}`, error: e.message }; }
        }
      } else token = { found: false };
    } catch (e) { token = { error: e.message }; }
    try { await onestock.ensureSiteDefaults(ctx, true); } catch (e) { seed = { ok: false, error: e.message }; }
    return { data: {
      deployment: {
        commit: process.env.VERCEL_GIT_COMMIT_SHA || null,
        branch: process.env.VERCEL_GIT_COMMIT_REF || null,
        vercel_env: process.env.VERCEL_ENV || null,
        url: process.env.VERCEL_URL || null,
      },
      context: ctx,
      seed,
      token: { ...token, encryption_key_set: secret.enabled() },
      ...(await db.diagnostic(ctx)),
    } };
  }
  if (req.action === "sites") return { data: { sites: await db.listSites(ctx) } };

  if (req.action === "set") {
    const changes = {};
    Object.entries(req.params || {}).forEach(([name, p]) => {
      if (!db.PARAMS[name] || !p || p.value === undefined) return;
      changes[name] = { value: normalize(name, p.value), scope: p.scope };
    });
    await db.setSettings(ctx, changes);
    onestock.clearConfigCache();
  }
  return { data: await describe(ctx) };
});
