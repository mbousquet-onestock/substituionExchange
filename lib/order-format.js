"use strict";

// Normalisation des commandes OneStock lues par GET /orders/{id}.
// Deux formats de réponse existent :
//   - format documenté : order_items + line_item_groups (+ pricing_details, shipping_fees)
//   - format observé sur certains sites : line_items unitaires (une entrée par article, avec state,
//     endpoint_id, payment.unit_price) + payment (address, currency, price, shipping_price…)
// normalize() ajoute au format "line_items" des order_items / line_item_groups équivalents
// (lignes regroupées par article, statut et point de stock, index_ranges reconstruits),
// et un pricing_details / shipping_fees déduits de payment. Le format documenté est renvoyé tel quel.

// Champs demandés pour lire la commande d'origine complète (liste validée sur l'API, parent_order_id inclus)
const FULL_ORDER_FIELDS = [
  "parent_order_id", "id", "types", "date", "last_update", "sales_channel", "state", "information",
  "original_ruleset_id", "original_ruleset_chaining_id", "ruleset_id", "expiration_dates",
  "customer", "customer.first_name", "customer.last_name", "customer.email", "customer.phone_number",
  "ordering.endpoint_id", "ordering.user_id", "reservation_rank",
  "delivery.type", "delivery.destination.address", "delivery.destination.endpoint_id", "delivery.destination.information",
  "pricing_details", "pricing_details.currency", "pricing_details.address", "pricing_details.price",
  "pricing_details.original_price", "pricing_details.taxes", "pricing_details.discounts",
  "order_items._id", "order_items.item_id", "order_items.quantity", "order_items.pricing_details",
  "order_items.pricing_details.price", "order_items.pricing_details.currency", "order_items.pricing_details.original_price",
  "order_items.pricing_details.unit_price", "order_items.pricing_details.original_unit_price",
  "order_items.pricing_details.taxes", "order_items.pricing_details.discounts", "order_items.information",
  "line_item_groups.id", "line_item_groups.order_id", "line_item_groups.order_item_id", "line_item_groups.item_id",
  "line_item_groups.endpoint_id", "line_item_groups.quantity", "line_item_groups.parcel_id", "line_item_groups.reason",
  "line_item_groups.epcs", "line_item_groups.last_update", "line_item_groups.state", "line_item_groups.index_ranges",
  "shipping_fees", "shipping_fees.price", "shipping_fees.original_price", "shipping_fees.taxes", "shipping_fees.discounts",
  "parcels.id", "parcels.order_id", "parcels.state", "parcels.line_item_index_ranges", "parcels.information",
  "parcels.delivery.destination.address", "parcels.delivery.destination.endpoint_id", "parcels.delivery.origin",
  "parcels.delivery.carrier", "parcels.delivery.type", "parcels.shipment.tracking_code", "parcels.shipment.tracking_link",
  "parcels.date", "parcels.last_update", "parcels.cutoffs_sets", "parcels.documents",
  "sent_delivery_option", "delivery_promise.original_delivery_option.delivery_routes",
  "delivery_promise.original_delivery_option.metric_values", "current_delivery_etas", "bundles",
];

function isNum(v) { return typeof v === "number" && !isNaN(v); }

// Regroupe des index triés en plages contiguës [{ from, to }]
function toRanges(indexes) {
  const ranges = [];
  indexes.slice().sort((a, b) => a - b).forEach((i) => {
    const last = ranges[ranges.length - 1];
    if (last && i === last.to + 1) last.to = i;
    else ranges.push({ from: i, to: i });
  });
  return ranges;
}

// line_items unitaires -> lignes regroupées par article / statut / point de stock / prix unitaire
function groupLineItems(lineItems, currency) {
  const groups = [];
  const byKey = {};
  lineItems.forEach((li, index) => {
    const p = li.payment || {};
    const unit = isNum(p.unit_price) ? p.unit_price : isNum(p.price) ? p.price : null;
    const key = [li.item_id, li.state, li.endpoint_id || "", unit].join("|");
    let g = byKey[key];
    if (!g) {
      g = byKey[key] = {
        id: li.id, // identifiant de la première unité
        line_item_ids: [],
        indexes: [],
        item_id: li.item_id,
        state: li.state,
        endpoint_id: li.endpoint_id,
        unit_price: unit,
        currency: p.currency || currency || undefined,
        carrier: li.delivery && li.delivery.carrier,
      };
      groups.push(g);
    }
    g.line_item_ids.push(li.id);
    g.indexes.push(index);
  });
  return groups.map((g) => ({ ...g, quantity: g.indexes.length, index_ranges: toRanges(g.indexes) }));
}

// Transporteur (non lisible via delivery.* dans GET /orders) : repris des lignes ou des colis
function withCarrier(order, candidates) {
  const carrier = candidates.concat((order.parcels || []).map((p) => p.delivery && p.delivery.carrier)).find((c) => c && c.name);
  if (!carrier || !order.delivery || order.delivery.carrier) return order;
  return { ...order, delivery: { ...order.delivery, carrier: { name: carrier.name, ...(carrier.option ? { option: carrier.option } : {}) } } };
}

// Ajoute order_items / line_item_groups / pricing_details / shipping_fees au format "line_items"
function normalize(order) {
  if (!order || typeof order !== "object") return order;
  if (Array.isArray(order.line_item_groups) && order.line_item_groups.length) return withCarrier(order, []);
  if (!Array.isArray(order.line_items) || !order.line_items.length) return withCarrier(order, []);

  const payment = order.payment || {};
  const currency = (order.pricing_details && order.pricing_details.currency) || payment.currency || undefined;
  const groups = groupLineItems(order.line_items, currency);

  const out = { ...order };
  out.order_items = groups.map((g) => ({
    id: g.id,
    item_id: g.item_id,
    quantity: g.quantity,
    pricing_details: {
      ...(isNum(g.unit_price) ? { unit_price: g.unit_price, price: g.unit_price * g.quantity } : {}),
      currency: g.currency || currency,
    },
  }));
  out.line_item_groups = groups.map((g) => ({
    id: g.id,
    order_item_id: g.id,
    item_id: g.item_id,
    quantity: g.quantity,
    state: g.state,
    endpoint_id: g.endpoint_id,
    index_ranges: g.index_ranges,
    line_item_ids: g.line_item_ids,
  }));
  if (!out.pricing_details && (payment.address || payment.currency || isNum(payment.price))) {
    out.pricing_details = {
      ...(payment.address ? { address: payment.address } : {}),
      ...(payment.currency ? { currency: payment.currency } : {}),
      ...(isNum(payment.price) ? { price: payment.price } : {}),
    };
  }
  if (!out.shipping_fees && isNum(payment.shipping_price)) {
    out.shipping_fees = [{ price: payment.shipping_price, currency: payment.shipping_currency || currency }];
  }
  return withCarrier(out, groups.map((g) => g.carrier));
}

module.exports = { normalize, groupLineItems, toRanges, FULL_ORDER_FIELDS };
