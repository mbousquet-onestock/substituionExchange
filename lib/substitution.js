"use strict";

// Confirmation d'une substitution :
//   1. lecture de la commande d'origine complète (GET /v3/orders/{id})
//   2. contrôles : lignes de la commande, statut éligible (substitution_states), statut cible configuré
//   3. création de la sous-commande (POST /v3/orders) : copie des données de la commande d'origine,
//      articles de substitution à 0 et frais de port à 0
//   4. passage des lignes substituées au statut configuré (PATCH /v3/line_item_groups)
// Tous les appels passent par onestock.call (token du site, journalisation).

const onestock = require("./onestock");
const ORDER_SCHEMA = require("./post-order-schema.json");

// Nombre maximal de sous-commandes par commande (suffixe -S1 … -S99)
const MAX_SUB_ORDERS = 99;

// Champs lus sur la commande d'origine (parents plutôt qu'enfants quand c'est possible)
const ORDER_FIELDS = [
  "id", "types", "date", "sales_channel", "state", "information",
  "original_ruleset_id", "original_ruleset_chaining_id", "customer",
  "ordering.endpoint_id", "ordering.user_id", "reservation_rank",
  "delivery.type", "delivery.destination.address", "delivery.destination.endpoint_id", "delivery.destination.information",
  "pricing_details", "shipping_fees",
  "order_items._id", "order_items.item_id", "order_items.quantity", "order_items.pricing_details", "order_items.information",
  "line_item_groups.id", "line_item_groups.order_item_id", "line_item_groups.item_id", "line_item_groups.endpoint_id",
  "line_item_groups.quantity", "line_item_groups.state", "line_item_groups.index_ranges",
];

function fail(status, code, message, vars) {
  return Object.assign(new Error(message), { status, code, vars });
}

// Garde uniquement les champs acceptés par le schéma de POST /orders (additionalProperties: false)
function prune(value, schema) {
  if (value === null || value === undefined || !schema) return undefined;
  if (Array.isArray(value)) {
    if (!schema.i) return undefined;
    const out = value.map((v) => prune(v, schema.i)).filter((v) => v !== undefined);
    return out;
  }
  if (typeof value === "object") {
    if (schema.o && !schema.p) return value; // objet libre (information…)
    const out = {};
    Object.keys(value).forEach((k) => {
      const sub = schema.p && schema.p[k];
      if (sub) {
        const v = prune(value[k], sub);
        if (v !== undefined) out[k] = v;
      } else if (schema.o) {
        out[k] = value[k];
      }
    });
    return out;
  }
  return value;
}

function zeroPrice(currency) {
  return { price: 0, original_price: 0, ...(currency ? { currency } : {}) };
}

// Construit la sous-commande à partir de la commande d'origine et des lignes substituées
// Numéro parent de la commande d'origine ("Parent number" du back-office) : champ order.parent_order_id
function findParent(order) {
  const v = order && order.parent_order_id;
  if (typeof v === "string" && v.trim()) return v.trim();
  if (typeof v === "number") return String(v);
  return null;
}

// parent : numéro parent de la commande d'origine (repris sur la sous-commande) ou null
function buildSubOrder(original, subOrderId, lines, parent) {
  const copy = prune(original, ORDER_SCHEMA) || {};
  delete copy.id;
  delete copy.date; // date de création = maintenant
  delete copy.payment_information; // aucun paiement à reprendre pour une commande à 0

  const currency = (original.pricing_details && original.pricing_details.currency)
    || (lines[0] && lines[0].currency) || undefined;

  // Montants de la commande à 0 (adresse de facturation et devise conservées)
  const pd = copy.pricing_details || {};
  copy.pricing_details = { ...(pd.address ? { address: pd.address } : {}), currency: pd.currency || currency, price: 0, original_price: 0 };

  // Frais de port repris à 0, sans taxes ni remises
  if (Array.isArray(copy.shipping_fees) && copy.shipping_fees.length) {
    copy.shipping_fees = copy.shipping_fees.map((f) => zeroPrice(f.currency || currency));
  } else {
    delete copy.shipping_fees;
  }

  // Articles de substitution à 0
  copy.order_items = lines.map((l) => ({
    item_id: l.substitute_item_id,
    quantity: l.quantity,
    pricing_details: { price: 0, original_price: 0, unit_price: 0, original_unit_price: 0 },
    information: {
      substitution_of_item_id: l.item_id,
      substitution_of_order_item_id: l.order_item_id || undefined,
      substitution_of_line_item_group_id: l.line_item_group_id,
    },
  }));

  // Lien avec la commande d'origine
  copy.information = {
    ...(copy.information || {}),
    original_order_id: original.id,
    substitution: {
      original_order_id: original.id,
      date: Math.floor(Date.now() / 1000),
      lines: lines.map((l) => ({
        line_item_group_id: l.line_item_group_id,
        item_id: l.item_id,
        substitute_item_id: l.substitute_item_id,
        quantity: l.quantity,
      })),
    },
  };

  copy.id = subOrderId;
  // Numéro parent repris de la commande d'origine
  if (parent) copy.parent_order_id = parent;
  else delete copy.parent_order_id;
  return copy;
}

async function getOrder(orderId, base) {
  return onestock.call({ ...base, method: "GET", path: `/v3/orders/${encodeURIComponent(orderId)}`, body: { fields: ORDER_FIELDS } });
}

// Premier identifiant libre : {commande}-S1, -S2…
async function nextSubOrderId(orderId, base) {
  for (let n = 1; n <= MAX_SUB_ORDERS; n++) {
    const id = `${orderId}-S${n}`;
    const r = await onestock.call({ ...base, method: "GET", path: `/v3/orders/${encodeURIComponent(id)}`, body: { fields: ["id"] } });
    if (r.status === 404) return id;
    if (r.status >= 400) throw fail(502, "onestock_error", `OneStock GET /v3/orders/${id} : ${r.status}`, { path: `/v3/orders/${id}`, status: r.status });
  }
  throw fail(409, "sub_order_limit", `Trop de sous-commandes pour la commande ${orderId}`, { order_id: orderId });
}

function onestockError(r, path) {
  const msg = r.data && (r.data.message || r.data.error || r.data.raw);
  return fail(r.status === 401 ? 401 : 502, "onestock", `OneStock ${path} : ${r.status}${msg ? " " + (typeof msg === "string" ? msg : JSON.stringify(msg)) : ""}`,
    { path, status: r.status, message: msg ? (typeof msg === "string" ? msg : JSON.stringify(msg)) : "" });
}

// request : { site_id, env, order_id, lines: [{ line_item_group_id, substitute_item_id }] }
async function confirm(request) {
  const siteId = onestock.resolveSiteId(request.site_id);
  const base = { siteId, env: request.env, internal: true };
  const cfg = await onestock.siteConfig(siteId, request.env);

  const target = cfg.substituted_state;
  if (!target) throw fail(400, "substituted_state_missing", "Statut des lignes substituées non configuré pour le site (page /config.html)", { site_id: siteId });

  const orderId = String(request.order_id || "").trim();
  if (!orderId) throw fail(400, "order_id_missing", "Numéro de commande manquant");
  const wanted = Array.isArray(request.lines) ? request.lines : [];
  if (!wanted.length) throw fail(400, "no_lines", "Aucune ligne à substituer");

  // 1. Commande d'origine
  const r = await getOrder(orderId, base);
  if (r.status !== 200) throw onestockError(r, `/v3/orders/${orderId}`);
  const original = r.data || {};
  const groups = original.line_item_groups || [];
  const items = original.order_items || [];

  // 2. Contrôles
  const eligible = cfg.substitution_states;
  const lines = wanted.map((w) => {
    const g = groups.find((x) => x.id === w.line_item_group_id);
    if (!g) throw fail(400, "line_not_found", `Ligne ${w.line_item_group_id} introuvable dans la commande ${orderId}`, { line: w.line_item_group_id, order_id: orderId });
    if (!eligible.includes("*") && !eligible.includes(g.state)) {
      throw fail(400, "line_not_eligible", `Substitution impossible pour le statut « ${g.state} »`, { state: g.state });
    }
    const sub = String(w.substitute_item_id || "").trim();
    if (!sub) throw fail(400, "substitute_missing", `Article de substitution manquant pour la ligne ${g.id}`, { line: g.id });
    if (!Array.isArray(g.index_ranges) || !g.index_ranges.length) {
      throw fail(400, "line_no_index", `Ligne ${g.id} sans index_ranges : changement de statut impossible`, { line: g.id });
    }
    const oi = items.find((o) => (o.id || o._id) === g.order_item_id) || {};
    return {
      line_item_group_id: g.id,
      order_item_id: g.order_item_id,
      item_id: g.item_id,
      quantity: g.quantity,
      state: g.state,
      endpoint_id: g.endpoint_id,
      index_ranges: g.index_ranges,
      substitute_item_id: sub,
      currency: oi.pricing_details && oi.pricing_details.currency,
    };
  });

  // Numéro parent : parent_order_id n'est pas proposé dans les "fields" de GET /orders,
  // on le lit sur la commande complète (GET sans filtre de champs)
  let parent = findParent(original);
  if (!parent) {
    const full = await onestock.call({ ...base, method: "GET", path: `/v3/orders/${encodeURIComponent(orderId)}`, body: {} });
    if (full.status === 200) parent = findParent(full.data);
  }

  // 3. Sous-commande (même parent_order_id que la commande d'origine)
  const subOrderId = await nextSubOrderId(orderId, base);
  const subOrder = buildSubOrder(original, subOrderId, lines, parent);
  const created = await onestock.call({ ...base, method: "POST", path: "/v3/orders", body: { order: subOrder } });
  if (created.status < 200 || created.status >= 300) throw onestockError(created, "/v3/orders");
  const createdId = (created.data && (created.data.id || (created.data.order && created.data.order.id))) || subOrderId;

  // 4. Statut des lignes substituées (une transition par ligne, depuis son statut actuel)
  const results = [];
  for (const l of lines) {
    const body = { order_id: orderId, index_ranges: l.index_ranges, from: l.state, to: target };
    if (l.endpoint_id) body.endpoint_id = l.endpoint_id;
    const u = await onestock.call({ ...base, method: "PATCH", path: "/v3/line_item_groups", body });
    const ok = u.status >= 200 && u.status < 300;
    results.push({
      line_item_group_id: l.line_item_group_id,
      from: l.state,
      to: target,
      ok,
      status: u.status,
      error: ok ? undefined : (u.data && (u.data.message || u.data.error || u.data.raw)) || `HTTP ${u.status}`,
    });
  }

  return {
    order_id: orderId,
    sub_order_id: createdId,
    substituted_state: target,
    lines: results,
    complete: results.every((x) => x.ok),
    parent_order_id: parent,
  };
}

module.exports = { confirm, buildSubOrder, findParent, prune, ORDER_FIELDS };
