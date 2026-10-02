"use strict";

// GET /api/orders/{id}?site_id=&lang=&extension_id=&user_id=&extension_signature=
// Proxy Vercel vers GET /v3/orders/{id} : token stocké en base, appel journalisé.
// Réponse : { status, data } (statut et body renvoyés par OneStock).

const { endpoint } = require("../../lib/http");
const onestock = require("../../lib/onestock");

module.exports = endpoint(async (params) => {
  const id = String(params.id || "").trim();
  if (!id) return { status: 400, data: { error: "Numéro de commande manquant", code: "order_id_missing" } };
  const lang = /^[a-z]{2}$/i.test(params.lang || "") ? params.lang.toLowerCase() : "en";
  const result = await onestock.call({
    method: "GET",
    path: `/v3/orders/${encodeURIComponent(id)}`,
    body: { fields: onestock.orderFields(), item_features_lang: lang },
    siteId: params.site_id,
  });
  return { data: result };
}, { methods: ["GET", "POST"] });
