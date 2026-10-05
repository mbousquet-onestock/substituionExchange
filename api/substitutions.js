"use strict";

// POST /api/substitutions
// Body : { order_id, lines: [{ line_item_group_id, substitute_item_id }], site_id, env,
//          extension_id, user_id, extension_signature }
// Crée la sous-commande (POST /v3/orders) puis passe les lignes substituées au statut configuré
// (PATCH /v3/line_item_groups). Réponse : { order_id, sub_order_id, substituted_state, lines, complete }.

const { endpoint } = require("../lib/http");
const substitution = require("../lib/substitution");

module.exports = endpoint(async (req) => ({ data: await substitution.confirm(req) }));
