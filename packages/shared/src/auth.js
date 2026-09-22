// Authentication & Security Utilities
// Provides OWASP-compliant password hashing via scrypt and signed session tokens via HMAC-SHA256

import crypto from "node:crypto";

const DEFAULT_KEY_LEN = 64;
const DEFAULT_SALT_LEN = 16;
const RANDOM_DEV_SECRET = crypto.randomBytes(32).toString("hex");

export function getEffectiveSecret(secret = null) {
  if (secret) return secret;
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  if (process.env.NODE_ENV === "production") {
    throw new Error("[Security] SESSION_SECRET environment variable is required in production mode.");
  }
  return RANDOM_DEV_SECRET;
}

/**
 * Hash a password using scrypt with a unique random salt.
 * Format: scrypt$<saltHex>$<derivedKeyHex>
 *
 * @param {string} password - Raw password text
 * @returns {string} Formatted hash string
 */
export function hashPassword(password) {
  if (!password || typeof password !== "string") {
    throw new Error("Password must be a non-empty string");
  }
  const salt = crypto.randomBytes(DEFAULT_SALT_LEN).toString("hex");
  const derivedKey = crypto.scryptSync(password, salt, DEFAULT_KEY_LEN);
  return `scrypt$${salt}$${derivedKey.toString("hex")}`;
}

/**
 * Verify a raw password against a stored password hash.
 * Supports scrypt format, with fallback verification for demo hashes.
 *
 * @param {string} password - Raw password text
 * @param {string} storedHash - Stored hash string
 * @returns {boolean} True if password matches
 */
export function verifyPassword(password, storedHash) {
  if (!password || !storedHash || typeof storedHash !== "string") {
    return false;
  }

  // Handle scrypt hashes
  if (storedHash.startsWith("scrypt$")) {
    const parts = storedHash.split("$");
    if (parts.length !== 3) return false;
    const salt = parts[1];
    const originalKey = Buffer.from(parts[2], "hex");
    const derivedKey = crypto.scryptSync(password, salt, originalKey.length);
    return crypto.timingSafeEqual(originalKey, derivedKey);
  }

  // Fallback for legacy demo hashes (demo$<sha256Hex>)
  if (storedHash.startsWith("demo$")) {
    const expected = "demo$" + crypto.createHash("sha256").update(password).digest("hex");
    const bStored = Buffer.from(storedHash, "utf8");
    const bExpected = Buffer.from(expected, "utf8");
    if (bStored.length !== bExpected.length) return false;
    return crypto.timingSafeEqual(bStored, bExpected);
  }

  return false;
}

/**
 * Generate a cryptographically signed session token.
 * Format: <payloadBase64Url>.<signatureBase64Url>
 *
 * @param {object} payload - Token payload (userId, clearance, etc.)
 * @param {string} secret - Secret key for HMAC
 * @param {number} expiresInMs - Expiration duration in milliseconds (default 24h)
 * @returns {string} Signed token string
 */
export function signSessionToken(payload, secret = null, expiresInMs = 24 * 60 * 60 * 1000) {
  const effectiveSecret = getEffectiveSecret(secret);
  const tokenPayload = {
    ...payload,
    exp: Date.now() + expiresInMs,
    iat: Date.now(),
  };

  const payloadB64 = Buffer.from(JSON.stringify(tokenPayload)).toString("base64url");
  const signature = crypto.createHmac("sha256", effectiveSecret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${signature}`;
}

/**
 * Verify and parse a signed session token.
 *
 * @param {string} token - Signed token string
 * @param {string} secret - Secret key for HMAC
 * @returns {object|null} Parsed payload if valid and not expired, null otherwise
 */
export function verifySessionToken(token, secret = null) {
  if (!token || typeof token !== "string") return null;

  const parts = token.split(".");
  if (parts.length !== 2) return null;

  let effectiveSecret;
  try {
    effectiveSecret = getEffectiveSecret(secret);
  } catch {
    return null;
  }

  const [payloadB64, signature] = parts;
  const expectedSignature = crypto.createHmac("sha256", effectiveSecret).update(payloadB64).digest("base64url");

  if (signature.length !== expectedSignature.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  try {
    const payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Date.now()) {
      return null; // Expired
    }
    return payload;
  } catch {
    return null;
  }
}
