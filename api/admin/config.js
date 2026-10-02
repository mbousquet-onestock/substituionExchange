"use strict";

// POST /api/admin/config  (en-tête X-Admin-Key)
// { action: "sites" }                                -> { sites: [{ site_id, updated_at }] }
// { action: "get", site_id }                          -> configuration du site
// { action: "set", site_id, token?, api_root?, default_lang? }
//   route / langue vides = retour à la valeur commune, puis par défaut (enregistrée pour le site) ;
//   token vide = suppression
// site_id "" = valeurs communes à tous les sites.

const { adminEndpoint } = require("../../lib/http");
const db = require("../../lib/db");
const onestock = require("../../lib/onestock");

function preview(token) {
  return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "****";
}

function checkSiteId(siteId) {
  const id = typeof siteId === "string" ? siteId.trim() : "";
  if (id && !/^[a-z0-9_-]{1,32}$/i.test(id)) throw Object.assign(new Error("site_id invalide"), { status: 400, code: "site_id_invalid" });
  return id;
}

async function describe(siteId) {
  // Route de l'API et langue par défaut toujours présentes en base pour le site
  await onestock.ensureSiteDefaults(siteId, true);
  const s = await db.getSiteSettings(siteId);
  const field = (f, fallback) => ({
    value: f ? f.value : fallback,
    updated_at: f ? f.updated_at : null,
    source: f ? (f.inherited ? "common" : "site") : "default",
  });
  return {
    site_id: siteId,
    token: s.token
      ? { set: true, preview: preview(s.token.value), updated_at: s.token.updated_at, source: s.token.inherited ? "common" : "site" }
      : { set: false },
    api_root: field(s.api_root, onestock.DEFAULT_API_ROOT),
    default_lang: field(s.default_lang, onestock.DEFAULT_LANG),
    defaults: { api_root: onestock.DEFAULT_API_ROOT, default_lang: onestock.DEFAULT_LANG },
  };
}

module.exports = adminEndpoint(async (req) => {
  if (req.action === "sites") return { data: { sites: await db.listSites() } };

  const siteId = checkSiteId(req.site_id);
  if (req.action === "set") {
    const changes = {};
    if (req.api_root !== undefined) {
      const raw = String(req.api_root || "").trim();
      const root = raw ? onestock.normalizeApiRoot(raw) : "";
      if (root === null) {
        return { status: 400, data: { error: "Route de l'API invalide : URL https en *.onestock-retail.com attendue (ex. https://api-qualif.onestock-retail.com)", code: "invalid_api_root" } };
      }
      changes.api_root = root;
    }
    if (req.default_lang !== undefined) {
      const raw = String(req.default_lang || "").trim();
      const lang = raw ? onestock.normalizeLang(raw) : "";
      if (lang === null) return { status: 400, data: { error: "Langue invalide : code à 2 lettres attendu (ex. fr)", code: "invalid_lang" } };
      changes.default_lang = lang;
    }
    if (req.token !== undefined) {
      const token = String(req.token || "").trim();
      if (token && !/^[\w.+/=-]{1,1024}$/.test(token)) return { status: 400, data: { error: "Format de token invalide", code: "invalid_token_format" } };
      changes.token = token;
    }
    await db.setSiteSettings(siteId, changes);
  }
  return { data: await describe(siteId) };
});
