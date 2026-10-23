"use strict";

// Lecture du token OneStock via l'API Settings de l'application Extensions
// (doc « API Settings — Extensions OneStock »), au lieu de la lecture directe en base.
//
// Variables d'environnement :
//   SETTINGS_API_URL  ex. https://extensions-lemon.vercel.app/api/settings
//   SETTINGS_API_KEY  clé d'API (une des valeurs de SETTINGS_API_KEYS côté Extensions)
//
// Lecture : GET {SETTINGS_API_URL}/item?key=onestock_token&site_id=…&extension_id=*&environment=…&decrypt=1
// valeur du site d'abord, puis valeur globale (site_id vide). La valeur renvoyée est déjà déchiffrée.
// Le token n'est jamais renvoyé au navigateur ni journalisé.

const TIMEOUT_MS = Number(process.env.SETTINGS_API_TIMEOUT_MS || 8000);

function apiUrl() {
  return String(process.env.SETTINGS_API_URL || "").trim().replace(/\/+$/, "");
}

function enabled() {
  return !!(apiUrl() && process.env.SETTINGS_API_KEY);
}

function fail(message, status, vars) {
  return Object.assign(new Error(message), { status: status || 502, code: "settings_api_error", vars });
}

// Lit un setting ; renvoie { value, site_id } ou null (404)
async function readSetting(key, siteId, environment, extensionId = "*") {
  const qs = new URLSearchParams({ key, site_id: siteId || "", extension_id: extensionId, environment, decrypt: "1" });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${apiUrl()}/item?${qs}`, {
      headers: { Authorization: `Bearer ${process.env.SETTINGS_API_KEY}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
  } catch (e) {
    throw fail(`API Settings injoignable : ${e.name === "AbortError" ? "délai dépassé" : e.message}`, 502);
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw fail(`API Settings ${res.status} : ${data.error || "erreur"}`, res.status === 401 || res.status === 503 ? 500 : 502, { status: res.status });
  const s = data.setting || {};
  if (s.decrypt_error) throw fail("API Settings : déchiffrement du token impossible côté Extensions (decrypt_error)", 500);
  return s.value == null ? null : { value: String(s.value), site_id: s.site_id ?? siteId };
}

// Token OneStock d'un site : valeur du site, sinon valeur globale.
// Renvoie { value, row: { extension_id, site_id }, source: "settings_api" } ou null.
async function getOnestockToken(siteId, environment) {
  const site = siteId ? await readSetting("onestock_token", siteId, environment) : null;
  const found = site || (await readSetting("onestock_token", "", environment));
  return found ? { value: found.value, row: { extension_id: "*", site_id: found.site_id }, source: "settings_api" } : null;
}

module.exports = { enabled, getOnestockToken, readSetting };
