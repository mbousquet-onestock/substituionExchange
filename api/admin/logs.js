"use strict";

// POST /api/admin/logs  (en-tête X-Admin-Key)
// { action: "list", site_id?, limit? } -> { logs: [...] } (plus récents d'abord ; sans site_id : tous les sites)
// { action: "clear", site_id? }        -> vide le journal (du site, ou entier)

const { adminEndpoint } = require("../../lib/http");
const db = require("../../lib/db");

module.exports = adminEndpoint(async (req) => {
  const siteId = typeof req.site_id === "string" && req.site_id.trim() ? req.site_id.trim() : null;
  if (req.action === "clear") {
    await db.clearLogs(siteId);
    return { data: { logs: [] } };
  }
  return { data: { logs: await db.listLogs(req.limit, siteId) } };
});
