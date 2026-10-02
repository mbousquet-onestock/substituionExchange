"use strict";

// POST /api/admin/logs  (en-tête X-Admin-Key)
// { action: "list", env?, site_id?, limit? } -> { logs: [...] } (plus récents d'abord ; extension courante)
// { action: "clear", env?, site_id? }        -> vide le journal correspondant

const { adminEndpoint } = require("../../lib/http");
const db = require("../../lib/db");
const onestock = require("../../lib/onestock");

module.exports = adminEndpoint(async (req) => {
  const filter = {
    extension_id: onestock.EXTENSION_ID,
    environment: req.env ? onestock.resolveEnv(req.env) : null,
    site_id: typeof req.site_id === "string" && req.site_id.trim() ? req.site_id.trim() : null,
  };
  if (req.action === "clear") {
    await db.clearLogs(filter);
    return { data: { logs: [] } };
  }
  return { data: { logs: await db.listLogs(req.limit, filter) } };
});
