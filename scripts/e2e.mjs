#!/usr/bin/env node
// End-to-end checks: the example app on a running Convex deployment, against real Tenki.
// Needs `npx convex dev` running (CONVEX_URL from .env.local) with TENKI_API_KEY set on
// the deployment, and TENKI_API_KEY in this shell for setup and cleanup.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { TenkiSandbox } from "@tenkicloud/sandbox";
import { adoptionTag, isLive } from "../dist/client/internal.js";

const env = Object.fromEntries(
  readFileSync(".env.local", "utf8")
    .split("\n")
    .filter((line) => /^[A-Z_]+=/.test(line))
    .map((line) => line.split(/=(.*)/s).slice(0, 2)),
);
const convexUrl = process.env.CONVEX_URL ?? env.CONVEX_URL;
// Must match the deployment's CONVEX_CLOUD_URL, which seeds the adoption namespace.
const namespace = process.env.E2E_NAMESPACE ?? convexUrl;
assert(convexUrl, "CONVEX_URL is not set");

const runId = Date.now().toString(36);
const runTag = `cvx-e2e:${runId}`;
const owner = (name) => `e2e-${runId}-${name}`;

const http = new ConvexHttpClient(convexUrl);
const live = new ConvexClient(convexUrl);
const sdk = new TenkiSandbox();
const api = anyApi;

const results = [];
async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - started });
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false, ms: Date.now() - started, err });
    console.log(`  ✗ ${name}\n    ${err?.stack ?? err}`);
  }
}

const create = (ownerId, key) =>
  http.action(api.workspaceActions.create, { ownerId, key, tags: [runTag] });
const exec = (ownerId, key, command) =>
  http.action(api.workspaceActions.exec, { ownerId, key, command });
const get = (ownerId, key) => http.query(api.workspace.get, { ownerId, key });
const destroy = (ownerId, key) =>
  http.action(api.workspaceActions.destroy, { ownerId, key });
const liveSessions = async (tag) =>
  (await sdk.list({ tags: [tag] })).filter(isLive);

console.log(`e2e run ${runId} against ${convexUrl}`);

try {
  await scenario(
    "create streams provisioning → ready to subscribers",
    async () => {
      const ownerId = owner("alice");
      const phases = [];
      const unsubscribe = live.onUpdate(
        api.workspace.get,
        { ownerId, key: "main" },
        (row) => {
          if (row && phases.at(-1) !== row.phase) phases.push(row.phase);
        },
      );
      const sandbox = await create(ownerId, "main");
      await new Promise((r) => setTimeout(r, 500));
      unsubscribe();
      assert.equal(sandbox.phase, "ready");
      assert.ok(sandbox.sessionId);
      assert.deepEqual(phases, ["provisioning", "ready"]);
    },
  );

  await scenario("exec runs shell strings and argv", async () => {
    const ownerId = owner("alice");
    const shell = await exec(
      ownerId,
      "main",
      "echo hello && uname -m && exit 3",
    );
    assert.equal(shell.exitCode, 3);
    assert.match(shell.stdout, /^hello\n(x86_64|aarch64)\n$/);
    const argv = await exec(ownerId, "main", ["printf", "%s", "a b"]);
    assert.equal(argv.exitCode, 0);
    assert.equal(argv.stdout, "a b");
    const stderr = await exec(ownerId, "main", "echo oops >&2");
    assert.equal(stderr.stderr, "oops\n");
  });

  await scenario("files written by exec persist across calls", async () => {
    const ownerId = owner("alice");
    await exec(ownerId, "main", "echo persisted > ~/note.txt");
    const read = await exec(ownerId, "main", "cat ~/note.txt");
    assert.equal(read.stdout, "persisted\n");
  });

  await scenario(
    "concurrent creates for one identity make one sandbox",
    async () => {
      const ownerId = owner("carol");
      const rows = await Promise.all(
        [1, 2, 3, 4, 5].map(() => create(ownerId, "main")),
      );
      assert.equal(new Set(rows.map((r) => r.sessionId)).size, 1);
      const sessions = await liveSessions(
        await adoptionTag(namespace, ownerId, "main"),
      );
      assert.equal(
        sessions.length,
        1,
        `expected 1 live session, got ${sessions.map((s) => s.id)}`,
      );
    },
  );

  await scenario("create adopts an orphan from a crashed create", async () => {
    const ownerId = owner("dave");
    const tag = await adoptionTag(namespace, ownerId, "main");
    const orphan = await sdk.create({
      tags: [tag, runTag],
      maxDurationMs: 15 * 60_000,
    });
    const sandbox = await create(ownerId, "main");
    assert.equal(sandbox.sessionId, orphan.id);
    assert.equal((await liveSessions(tag)).length, 1);
  });

  await scenario("owners cannot see each other's sandboxes", async () => {
    assert.equal(await get(owner("mallory"), "main"), null);
    assert.ok(await get(owner("alice"), "main"));
  });

  await scenario("destroy terminates, and the key can be reused", async () => {
    const ownerId = owner("alice");
    const before = await get(ownerId, "main");
    const destroyed = await destroy(ownerId, "main");
    assert.equal(destroyed.phase, "terminated");
    assert.equal(
      (await liveSessions(await adoptionTag(namespace, ownerId, "main")))
        .length,
      0,
    );
    const again = await create(ownerId, "main");
    assert.equal(again.phase, "ready");
    assert.notEqual(again.sessionId, before.sessionId);
    await destroy(ownerId, "main");
  });

  await scenario("exec on a terminated sandbox reports not_ready", async () => {
    await assert.rejects(
      exec(owner("alice"), "main", "true"),
      (err) => err?.data?.code === "not_ready",
    );
  });
} finally {
  await live.close();
  const leftovers = await liveSessions(runTag);
  for (const s of leftovers)
    await s
      .close()
      .catch((err) => console.log(`  cleanup failed for ${s.id}: ${err}`));
  const remaining = await liveSessions(runTag);
  console.log(
    `cleanup: terminated ${leftovers.length}, remaining ${remaining.length}`,
  );
  if (remaining.length) results.push({ name: "cleanup", ok: false });
}

const failed = results.filter((r) => !r.ok);
console.log(`${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
