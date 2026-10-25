const crypto = require("crypto");

/**
 * Encrypts channel credentials (WhatsApp tokens, Twilio auth tokens, ...) before they are stored.
 * AES-256-GCM with a key derived from CHANNEL_CREDENTIAL_KEY. If the key is not configured the
 * functions refuse to run, so a secret is never stored in plain text by accident.
 */
const MIN_KEY_LENGTH = 32;

function getKey() {
  const secret = process.env.CHANNEL_CREDENTIAL_KEY;
  if (!secret || secret.length < MIN_KEY_LENGTH) return null;
  return crypto.createHash("sha256").update(secret, "utf8").digest();
}

function isConfigured() {
  return getKey() !== null;
}

function encryptJson(value) {
  const key = getKey();
  if (!key) throw new Error("CHANNEL_CREDENTIAL_KEY is not configured (it must be at least 32 characters).");
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ["v1", iv.toString("base64"), tag.toString("base64"), ciphertext.toString("base64")].join(":");
}

function decryptJson(payload) {
  const key = getKey();
  if (!key) throw new Error("CHANNEL_CREDENTIAL_KEY is not configured (it must be at least 32 characters).");
  const parts = String(payload || "").split(":");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Stored credentials are in an unknown format.");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64"));
  const plain = Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]);
  return JSON.parse(plain.toString("utf8"));
}

module.exports = { isConfigured, encryptJson, decryptJson };
