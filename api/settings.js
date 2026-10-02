"use strict";

// GET /api/settings?site_id=&extension_id=&user_id=&extension_signature=
// Paramètres publics du site pour la pop-up : { default_lang }.

const { endpoint } = require("../lib/http");
const onestock = require("../lib/onestock");

module.exports = endpoint(async (params) => {
  const cfg = await onestock.siteConfig(onestock.resolveSiteId(params.site_id));
  return { data: { default_lang: cfg.default_lang } };
}, { methods: ["GET", "POST"] });
