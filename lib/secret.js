"use strict";

// Chiffrement des settings sensibles (onestock_token), identique au module settings-secrets.mjs
// de l'application Extensions qui partage la table settings.
//
// Format : `enc:v1:` + base64(iv 12 octets | tag 16 octets | texte chiffré), AES-256-GCM.
// Une valeur sans préfixe `enc:v1:` (ancienne valeur en clair) est renvoyée telle quelle.
// Clé SETTINGS_ENCRYPTION_KEY : 64 caractères hex, 32 octets en base64, ou phrase secrète (SHA-256).

const crypto = require("crypto");

const PREFIX = "enc:v1:";

function rawKey() {
  return String(process.env.SETTINGS_ENCRYPTION_KEY || "").trim();
}

function enabled() {
  return !!rawKey();
}

// Même dérivation que l'application Extensions
function encryptionKey() {
  const value = rawKey();
  if (!value) throw Object.assign(new Error("SETTINGS_ENCRYPTION_KEY is not set"), { status: 500, code: "encryption_key_missing" });
  if (/^[\da-f]{64}$/i.test(value)) return Buffer.from(value, "hex");
  const b64 = Buffer.from(value, "base64");
  if (b64.length === 32 && /^[A-Za-z0-9+/=_-]+$/.test(value)) return b64;
  return crypto.createHash("sha256").update(value).digest();
}

// Renvoie { value, format } ; format = "enc:v1" si la valeur était chiffrée, null sinon
function decrypt(stored) {
  if (typeof stored !== "string" || !stored.startsWith(PREFIX)) return { value: stored, format: null };
  try {
    const buf = Buffer.from(stored.slice(PREFIX.length), "base64");
    const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey(), buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    const value = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
    return { value, format: "enc:v1" };
  } catch (e) {
    if (e.code === "encryption_key_missing") throw e;
    throw Object.assign(new Error("Impossible de déchiffrer onestock_token avec SETTINGS_ENCRYPTION_KEY"),
      { status: 500, code: "token_decrypt_failed" });
  }
}

// Chiffre une valeur au format enc:v1 (relisible par l'application Extensions).
// Sans SETTINGS_ENCRYPTION_KEY, la valeur est enregistrée en clair.
function encrypt(plain) {
  if (!plain || !enabled()) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
  return PREFIX + Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
}

// Empreinte d'un token pour le diagnostic (jamais la valeur complète)
function fingerprint(value) {
  const v = String(value || "");
  return {
    length: v.length,
    start: v.slice(0, 4),
    end: v.length > 8 ? v.slice(-4) : "",
    sha256: crypto.createHash("sha256").update(v).digest("hex").slice(0, 12),
    charset: /^[0-9a-f]+$/i.test(v) ? "hex" : /^[\w.+/=-]+$/.test(v) ? "token" : "autre",
  };
}

module.exports = { decrypt, encrypt, enabled, fingerprint, PREFIX };
