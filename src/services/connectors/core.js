const crypto = require("crypto");

/** An error from talking to a messaging provider, with a message safe to show to a business user. */
class ConnectorError extends Error {
  constructor(message, { code = null, status = null, retryable = false } = {}) {
    super(message);
    this.name = "ConnectorError";
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

/** Meta (WhatsApp, Messenger, Instagram) signs the exact raw body with the app secret. */
function verifyMetaSignature(rawBody, header, appSecret) {
  if (typeof rawBody !== "string" || !header || !appSecret) return false;
  const expected = `sha256=${crypto.createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex")}`;
  return safeEqual(expected, header);
}

/** Calls an HTTP API with a timeout and returns { status, ok, json }; never throws on HTTP errors. */
async function httpJson(url, { method = "GET", headers = {}, body, timeoutMs = 10000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { method, headers, body, signal: controller.signal });
    let json = null;
    try {
      json = await response.json();
    } catch (error) {
      json = null;
    }
    return { status: response.status, ok: response.ok, json };
  } catch (error) {
    if (error && error.name === "AbortError") {
      throw new ConnectorError("The messaging provider did not answer in time.", { retryable: true });
    }
    throw new ConnectorError("Could not reach the messaging provider.", { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

/** Keeps provider error text short and free of anything that looks like a credential. */
function cleanProviderText(value, fallback) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return fallback;
  return text.slice(0, 300);
}

module.exports = { ConnectorError, safeEqual, verifyMetaSignature, httpJson, cleanProviderText };
