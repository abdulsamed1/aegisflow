/**
 * Web Crypto AES-256-GCM PII Encryption Helper
 * Conforms to Architectural Invariant AD-3
 */

async function getKey(secret: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret.padEnd(32, "0").slice(0, 32)),
    { name: "PBKDF2" },
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt: enc.encode("opran-booking-salt"),
      iterations: 100000,
      hash: "SHA-256"
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptPII(plaintext: string, secret: string): Promise<string> {
  if (!plaintext) return "";
  const key = await getKey(secret);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    enc.encode(plaintext)
  );

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}

export async function decryptPII(ciphertextBase64: string, secret: string): Promise<string> {
  if (!ciphertextBase64) return "";
  const key = await getKey(secret);
  const combined = Uint8Array.from(atob(ciphertextBase64), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, 12);
  const data = combined.slice(12);

  const decrypted = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv },
    key,
    data
  );

  const dec = new TextDecoder();
  return dec.decode(decrypted);
}

export function maskPassport(passportNumber: string): string {
  if (!passportNumber || passportNumber.length < 4) return "****";
  const len = passportNumber.length;
  return `${passportNumber.slice(0, 2)}****${passportNumber.slice(len - 2)}`;
}
