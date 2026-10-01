#!/usr/bin/env node
// Sets the Convex Auth signing keys and SITE_URL on the current deployment.
// Usage: node scripts/setup-demo-auth.mjs [siteUrl]
import { execFileSync } from "node:child_process";
import { exportJWK, exportPKCS8, generateKeyPair } from "jose";

const siteUrl = process.argv[2] ?? "http://localhost:5173";
const keys = await generateKeyPair("RS256", { extractable: true });
const privateKey = (await exportPKCS8(keys.privateKey))
  .trimEnd()
  .replace(/\n/g, " ");
const jwks = JSON.stringify({
  keys: [{ use: "sig", ...(await exportJWK(keys.publicKey)) }],
});

for (const [name, value] of [
  ["JWT_PRIVATE_KEY", privateKey],
  ["JWKS", jwks],
  ["SITE_URL", siteUrl],
]) {
  execFileSync("npx", ["convex", "env", "set", "--force", name], {
    input: value,
    stdio: ["pipe", "inherit", "inherit"],
  });
}
