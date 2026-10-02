"use strict";

// GET /api/settings?site_id=&env=&extension_id=&user_id=&extension_signature=
// Paramètres du site utiles à la pop-up : { default_lang, substitution_states, environment }.

const { endpoint } = require("../lib/http");
const onestock = require("../lib/onestock");

module.exports = endpoint(async (params) => {
  const cfg = await onestock.siteConfig(onestock.resolveSiteId(params.site_id), params.env);
  return { data: { default_lang: cfg.default_lang, substitution_states: cfg.substitution_states, environment: cfg.ctx.environment } };
}, { methods: ["GET", "POST"] });
