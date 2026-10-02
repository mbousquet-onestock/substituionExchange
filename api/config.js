"use strict";

// POST /api/config
// { action: "get" }            -> { token_set, token_preview, updated_at }
// { action: "set", token: "" } -> enregistre (ou efface si vide) le token API OneStock en base

const { endpoint } = require("../lib/http");
const db = require("../lib/db");

function preview(token) {
  return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : "****";
}

async function describe() {
  const stored = await db.getToken();
  return stored
    ? { token_set: true, token_preview: preview(stored.token), updated_at: stored.updated_at }
    : { token_set: false };
}

module.exports = endpoint(async (req) => {
  if (req.action === "set") {
    const token = typeof req.token === "string" ? req.token.trim() : "";
    if (token && !/^[\w.+/=-]{1,1024}$/.test(token)) return { status: 400, data: { error: "Format de token invalide" } };
    await db.setToken(token);
  }
  return { data: await describe() };
});
