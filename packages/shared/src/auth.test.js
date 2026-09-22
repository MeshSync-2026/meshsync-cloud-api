import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  verifySessionToken,
} from "./auth.js";

describe("Shared Auth — scrypt password hashing", () => {
  test("hashes password with salt", () => {
    const hash = hashPassword("secret123");
    assert.ok(hash.startsWith("scrypt$"));
    const parts = hash.split("$");
    assert.equal(parts.length, 3);
    assert.equal(parts[1].length, 32); // 16 bytes hex
    assert.equal(parts[2].length, 128); // 64 bytes hex
  });

  test("two hashes of same password have different salts", () => {
    const h1 = hashPassword("secret123");
    const h2 = hashPassword("secret123");
    assert.notEqual(h1, h2);
    assert.equal(verifyPassword("secret123", h1), true);
    assert.equal(verifyPassword("secret123", h2), true);
  });

  test("verifyPassword succeeds with correct password", () => {
    const hash = hashPassword("mySuperPass!");
    assert.equal(verifyPassword("mySuperPass!", hash), true);
  });

  test("verifyPassword fails with incorrect password", () => {
    const hash = hashPassword("mySuperPass!");
    assert.equal(verifyPassword("wrongPass", hash), false);
  });

  test("verifyPassword supports legacy demo$ hashes", () => {
    const legacyHash = "demo$0ead2060b65992dca4769af601a1b3a35ef38cfad2c2c465bb160ea764157c5d"; // sha256 of demo1234
    assert.equal(verifyPassword("demo1234", legacyHash), true);
    assert.equal(verifyPassword("wrong", legacyHash), false);
  });
});

describe("Shared Auth — signed session tokens", () => {
  const secret = "test-secret-key-for-unit-testing!";

  test("signs and verifies session token", () => {
    const payload = { userId: "user-123", clearance: "COMMANDER" };
    const token = signSessionToken(payload, secret);
    assert.ok(token);

    const verified = verifySessionToken(token, secret);
    assert.ok(verified);
    assert.equal(verified.userId, "user-123");
    assert.equal(verified.clearance, "COMMANDER");
    assert.ok(verified.exp > Date.now());
  });

  test("rejects tampered token", () => {
    const payload = { userId: "user-123", clearance: "DISPATCHER" };
    const token = signSessionToken(payload, secret);
    const tampered = token.slice(0, -5) + "abcde";
    assert.equal(verifySessionToken(tampered, secret), null);
  });

  test("rejects token verified with wrong secret", () => {
    const payload = { userId: "user-123" };
    const token = signSessionToken(payload, secret);
    assert.equal(verifySessionToken(token, "wrong-secret-key"), null);
  });

  test("rejects expired token", async () => {
    const payload = { userId: "user-123" };
    const token = signSessionToken(payload, secret, 5); // 5ms expiry
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(verifySessionToken(token, secret), null);
  });
});
