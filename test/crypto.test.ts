import test from "node:test";
import assert from "node:assert";
import { encryptPII, decryptPII, maskPassport } from "../src/crypto";

test("Crypto Module: Encrypt and Decrypt PII round-trip", async () => {
  const secret = "production-test-key-32-chars-ok";
  const plaintext = "N12345678";

  const encrypted = await encryptPII(plaintext, secret);
  assert.notStrictEqual(encrypted, plaintext, "Ciphertext must not match plaintext");
  assert.ok(encrypted.length > 0, "Ciphertext must not be empty");

  const decrypted = await decryptPII(encrypted, secret);
  assert.strictEqual(decrypted, plaintext, "Decrypted text must match original plaintext");
});

test("Crypto Module: Mask Passport correctly", () => {
  assert.strictEqual(maskPassport("A1234567B"), "A1****7B");
  assert.strictEqual(maskPassport("123"), "****");
  assert.strictEqual(maskPassport(""), "****");
});
