"use strict";

// Chiffrement / déchiffrement du token OneStock stocké dans la table settings (clé onestock_token),
// avec la clé SETTINGS_ENCRYPTION_KEY (partagée avec les autres applicatifs utilisant la table).
//
// Clé : 64 caractères hexadécimaux, ou base64 de 32 octets, sinon SHA-256 du texte fourni.
// Formats reconnus au déchiffrement (préfixe éventuel "enc:" / "v1:" ignoré) :
//   gcm-parts    iv:tag:ciphertext       AES-256-GCM, parties en hexadécimal ou en base64
//   gcm-b64      base64(iv12 | tag16 | ciphertext)   AES-256-GCM
//   gcm-b64-tail base64(iv12 | ciphertext | tag16)   AES-256-GCM (format WebCrypto)
//   cbc-parts    iv:ciphertext            AES-256-CBC, parties en hexadécimal ou en base64
// Une valeur qui ne correspond à aucun format chiffré (ex. token hexadécimal de 32 caractères) est utilisée
// telle quelle ; une valeur au format chiffré qui ne se déchiffre pas (mauvaise clé) est une erreur.
// Chiffrement (enregistrement depuis /config.html) : format gcm-parts en hexadécimal.

const crypto = require("crypto");

const TOKEN_RE = /^[\w.+/=-]{1,1024}$/;

function rawKey() {
  return String(process.env.SETTINGS_ENCRYPTION_KEY || "").trim();
}

function enabled() {
  return !!rawKey();
}

function key() {
  const k = rawKey();
  if (/^[0-9a-f]{64}$/i.test(k)) return Buffer.from(k, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(k)) {
    const b = Buffer.from(k.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    if (b.length === 32) return b;
  }
  return crypto.createHash("sha256").update(k, "utf8").digest();
}

// Décode une partie hexadécimale ou base64
function decodePart(s) {
  if (/^[0-9a-f]+$/i.test(s) && s.length % 2 === 0) return Buffer.from(s, "hex");
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(s)) return Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  return null;
}

function gcm(k, iv, tag, data) {
  const d = crypto.createDecipheriv("aes-256-gcm", k, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

function cbc(k, iv, data) {
  const d = crypto.createDecipheriv("aes-256-cbc", k, iv);
  return Buffer.concat([d.update(data), d.final()]).toString("utf8");
}

// Plaintext plausible pour un token (évite d'accepter un faux positif CBC)
function plausible(s) {
  return typeof s === "string" && TOKEN_RE.test(s);
}

// Renvoie { value, format } ; format = null si la valeur est utilisée telle quelle
function decrypt(stored) {
  const value = String(stored || "").trim();
  if (!value || !enabled()) return { value, format: null };
  const k = key();
  const body = value.replace(/^(enc|v1|aes|gcm):/i, "");
  const parts = body.split(":");
  const attempts = [];

  if (parts.length === 3) {
    attempts.push(["gcm-parts", () => {
      const [iv, tag, data] = parts.map(decodePart);
      return gcm(k, iv, tag, data);
    }]);
  }
  if (parts.length === 2) {
    attempts.push(["cbc-parts", () => {
      const [iv, data] = parts.map(decodePart);
      return cbc(k, iv, data);
    }]);
  }
  if (parts.length === 1) {
    const buf = decodePart(body);
    if (buf && buf.length > 28) {
      attempts.push(["gcm-b64", () => gcm(k, buf.subarray(0, 12), buf.subarray(12, 28), buf.subarray(28))]);
      attempts.push(["gcm-b64-tail", () => gcm(k, buf.subarray(0, 12), buf.subarray(buf.length - 16), buf.subarray(12, buf.length - 16))]);
    }
  }

  for (const [format, fn] of attempts) {
    try {
      const plain = fn();
      if (plausible(plain)) return { value: plain, format };
    } catch (e) { /* format suivant */ }
  }
  // Token en clair : seulement si la valeur ne correspond à aucun format chiffré (sinon : mauvaise clé)
  if (!attempts.length && plausible(value)) return { value, format: null };
  const err = new Error("Impossible de déchiffrer onestock_token avec SETTINGS_ENCRYPTION_KEY");
  throw Object.assign(err, { status: 500, code: "token_decrypt_failed" });
}

// Chiffre un token pour l'enregistrement (iv:tag:ciphertext en hexadécimal, AES-256-GCM)
function encrypt(plain) {
  if (!plain || !enabled()) return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", key(), iv);
  const data = Buffer.concat([c.update(String(plain), "utf8"), c.final()]);
  return `${iv.toString("hex")}:${c.getAuthTag().toString("hex")}:${data.toString("hex")}`;
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

module.exports = { decrypt, encrypt, enabled, fingerprint };
