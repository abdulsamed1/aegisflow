#!/usr/bin/env node
/**
 * Materializes wrangler.toml from the committed wrangler.toml.example.
 *
 * wrangler.toml is intentionally NOT committed (it carries account-specific
 * resource identifiers). Workers Builds runs `npm run build` before its deploy
 * command, so this script rebuilds the file from the example at build time
 * using build variables configured in the Worker's Settings → Build:
 *
 *   D1_DATABASE_ID    (required)  D1 database UUID as shown by `wrangler d1 list`
 *   D1_DATABASE_NAME  (optional)  D1 label, default "aegisflow-db".
 *                                 Must match `wrangler d1 list` truth — the
 *                                 binding resolves by database_id; the label
 *                                 only affects name-based `wrangler d1` commands.
 *   KV_NAMESPACE_ID   (required)  KV namespace id as shown by `wrangler kv namespace list`
 *
 * Local development: run with these variables set, or simply copy
 * wrangler.toml.example to wrangler.toml and fill in your own resources.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const templatePath = join(repoRoot, "wrangler.toml.example");
const outputPath = join(repoRoot, "wrangler.toml");

function requireEnv(name) {
  const value = process.env[name];
  if (!value || value.startsWith("YOUR_")) {
    console.error(`[generate-wrangler] required build variable ${name} is missing`);
    console.error("[generate-wrangler] CI: set it under Worker → Settings → Build → Build variables and secrets");
    console.error("[generate-wrangler] local: pass it inline, or copy wrangler.toml.example to wrangler.toml manually");
    process.exit(1);
  }
  return value;
}

const d1DatabaseId = requireEnv("D1_DATABASE_ID");
const kvNamespaceId = requireEnv("KV_NAMESPACE_ID");
const d1DatabaseName = process.env.D1_DATABASE_NAME?.startsWith("YOUR_")
  ? "aegisflow-db"
  : process.env.D1_DATABASE_NAME || "aegisflow-db";

let content = readFileSync(templatePath, "utf8");

// Line-anchored replacements only — never touch the explanatory comments.
content = content.replace(/^database_name = "[^"]*"$/m, `database_name = "${d1DatabaseName}"`);
content = content.replace(/^database_id = "YOUR_D1_DATABASE_ID"$/m, `database_id = "${d1DatabaseId}"`);
content = content.replace(/^id = "YOUR_KV_NAMESPACE_ID"$/m, `id = "${kvNamespaceId}"`);

// Fail loudly if the example drifts (renamed/rerapped lines, leftover placeholders).
const unresolved = content.match(/YOUR_[A-Z0-9_]+/g);
for (const [what, expected] of [
  ["D1 database_name", `database_name = "${d1DatabaseName}"`],
  ["D1 database_id", `database_id = "${d1DatabaseId}"`],
  ["KV id", `id = "${kvNamespaceId}"`],
]) {
  if (!content.includes(expected)) {
    console.error(`[generate-wrangler] failed to inject ${what} — did wrangler.toml.example change shape?`);
    process.exit(1);
  }
}
if (unresolved) {
  console.error(`[generate-wrangler] unresolved template placeholders: ${[...new Set(unresolved)].join(", ")}`);
  process.exit(1);
}

writeFileSync(outputPath, content);

const short = (id) => `${id.slice(0, 8)}…`;
console.log(
  `[generate-wrangler] wrangler.toml generated (D1: ${d1DatabaseName} ${short(d1DatabaseId)}, KV: ${short(kvNamespaceId)})`
);
