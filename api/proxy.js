"use strict";

// POST /api/proxy
// Body : { method: "GET", path: "/v3/orders/ORD1", body: {...}, site_id, extension_id, user_id, extension_signature }
// Appelle l'API OneStock avec le token stocké en base et renvoie { status, data } tel que reçu.

const { endpoint } = require("../lib/http");
const onestock = require("../lib/onestock");

module.exports = endpoint(async (req) => {
  const result = await onestock.call({ method: req.method, path: req.path, body: req.body, siteId: req.site_id, env: req.env });
  return { status: 200, data: result };
});
