"use strict";

// Utilitaires communs aux fonctions Vercel (api/*.js) et au serveur de dev local.

const { isSignatureValid } = require("./signature");

function send(res, status, data) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

// Vercel parse déjà le JSON dans req.body ; en local on lit le flux.
function readBody(req) {
  if (req.body !== undefined) {
    return Promise.resolve(typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body || {});
  }
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 1e6) req.destroy();
    });
    req.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(Object.assign(e, { status: 400 })); }
    });
    req.on("error", reject);
  });
}

// Enveloppe un handler : POST JSON uniquement, signature de l'extension vérifiée, erreurs en JSON.
function endpoint(handler) {
  return async (req, res) => {
    try {
      if (req.method !== "POST") return send(res, 405, { error: "Méthode non autorisée" });
      const body = await readBody(req);
      if (!isSignatureValid(body)) return send(res, 401, { error: "Signature d'extension invalide" });
      const result = await handler(body);
      send(res, result.status || 200, result.data);
    } catch (e) {
      send(res, e.status || 500, { error: e.message, auth_error: !!e.auth });
    }
  };
}

module.exports = { send, readBody, endpoint };
