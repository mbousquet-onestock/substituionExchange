"use strict";

// Vérification de la signature de l'extension (cf. doc OneStock "UI Extensibility").
// EXTENSION_SECRET_KEYS : clés secrètes séparées par des virgules (courante, précédente, plus ancienne).

const crypto = require("crypto");

function secretKeys() {
  return (process.env.EXTENSION_SECRET_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
}

function checkExtensionSignature(ctx, secretKey) {
  const signature = ctx.extension_signature;
  if (!signature) return false;
  const parts = String(signature).split(",");
  if (parts.length < 2) return false;

  const timestamp = parts[0].replace("t=", "");
  if (Math.floor(Date.now() / 1000) - parseInt(timestamp, 10) > 60 * 60 * 6) return false;

  const expected = crypto.createHmac("sha256", secretKey)
    .update(`${timestamp}.${ctx.extension_id}##${ctx.user_id}`)
    .digest("hex");

  for (let i = 1; i < parts.length; i++) {
    const h = parts[i].replace(`h${i - 1}=`, "");
    if (h.length === expected.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(expected))) return true;
  }
  return false;
}

function isSignatureValid(ctx) {
  const keys = secretKeys();
  if (!keys.length) return true; // vérification désactivée (développement)
  return keys.some((key) => checkExtensionSignature(ctx || {}, key));
}

module.exports = { checkExtensionSignature, isSignatureValid, secretKeys };
