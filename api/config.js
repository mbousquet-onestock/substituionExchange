"use strict";

// POST /api/config
// { action: "get" } -> { token_set, token_preview, updated_at, api_root, api_root_default }
// { action: "set", token?: "...", api_root?: "..." }
//   - token    : enregistre le token API OneStock (vide = suppression)
//   - api_root : route de l'API OneStock (vide = valeur par défaut)
// Seuls les champs présents sont modifiés.

const { endpoint } = require("../lib/http");
const db = require("../lib/db");
const onestock = require("../lib/onestock");

function preview(token) {
  return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "****";
}

async function describe() {
  const [stored, root] = await Promise.all([db.getToken(), db.getApiRoot()]);
  return {
    ...(stored
      ? { token_set: true, token_preview: preview(stored.token), updated_at: stored.updated_at }
      : { token_set: false }),
    api_root: (root && root.value) || onestock.DEFAULT_API_ROOT,
    api_root_default: onestock.DEFAULT_API_ROOT,
  };
}

module.exports = endpoint(async (req) => {
  if (req.action === "set") {
    if (req.api_root !== undefined) {
      const raw = typeof req.api_root === "string" ? req.api_root.trim() : "";
      const root = raw ? onestock.normalizeApiRoot(raw) : "";
      if (root === null) {
        return { status: 400, data: { error: "Route de l'API invalide : URL https en *.onestock-retail.com attendue (ex. https://api-qualif.onestock-retail.com)" } };
      }
      await db.setApiRoot(root === onestock.DEFAULT_API_ROOT ? "" : root);
    }
    if (req.token !== undefined) {
      const token = typeof req.token === "string" ? req.token.trim() : "";
      if (token && !/^[\w.+/=-]{1,1024}$/.test(token)) return { status: 400, data: { error: "Format de token invalide" } };
      await db.setToken(token);
    }
  }
  return { data: await describe() };
});
