"use strict";

// POST /api/logs
// { action: "list", limit: 100 } -> { logs: [...] } (plus récents d'abord)
// { action: "clear" }            -> vide le journal

const { endpoint } = require("../lib/http");
const db = require("../lib/db");

module.exports = endpoint(async (req) => {
  if (req.action === "clear") {
    await db.clearLogs();
    return { data: { logs: [] } };
  }
  return { data: { logs: await db.listLogs(req.limit) } };
});
