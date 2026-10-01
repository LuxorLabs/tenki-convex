#!/usr/bin/env node
// End-to-end checks: the example app's e2e harness on a running Convex deployment,
// against real Tenki. Needs TENKI_API_KEY and TENKI_E2E=1 set on the deployment and
// TENKI_API_KEY in this shell for setup and cleanup. E2E_SLOW=1 adds the scenarios
// that wait for a real deadline.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { ConvexClient, ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";
import { TenkiSandbox } from "@tenkicloud/sandbox";
import { adoptionTag, isLive } from "../dist/client/internal.js";

function envLocal() {
  try {
    return Object.fromEntries(
      readFileSync(".env.local", "utf8")
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => line.split(/=(.*)/s).slice(0, 2)),
    );
  } catch {
    return {};
  }
}

const convexUrl = process.env.CONVEX_URL ?? envLocal().CONVEX_URL;
assert(convexUrl, "CONVEX_URL is not set");
// Must match the deployment's CONVEX_CLOUD_URL, which seeds the adoption namespace.
const namespace = process.env.E2E_NAMESPACE ?? convexUrl;
const slow = process.env.E2E_SLOW === "1";

const runId = Date.now().toString(36);
const runTag = `cvx-e2e:${runId}`;
const owner = (name) => `e2e-${runId}-${name}`;

const http = new ConvexHttpClient(convexUrl);
const live = new ConvexClient(convexUrl);
const sdk = new TenkiSandbox();
const api = anyApi;

const act = (name, args) => http.action(api.e2e[name], args);
const get = (ownerId, key) => http.query(api.e2eQueries.get, { ownerId, key });
const create = (ownerId, key) =>
  act("create", { ownerId, key, tags: [runTag] });
const exec = (who, command) => act("exec", { ...who, command });
const liveSessions = async (tag) =>
  (await sdk.list({ tags: [tag] })).filter(isLive);
const codeIs = (code) => (err) => err?.data?.code === code;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(what, fn, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn().catch(() => undefined);
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(1_000);
  }
}

const results = [];
async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${Date.now() - started}ms)`);
  } catch (err) {
    results.push({ name, ok: false });
    console.log(`  ✗ ${name}\n    ${err?.stack ?? err}`);
  }
}

console.log(
  `e2e run ${runId} against ${convexUrl}${slow ? " (with slow scenarios)" : ""}`,
);
const alice = { ownerId: owner("alice"), key: "main" };
let server;

try {
  await scenario(
    "create streams provisioning → ready to subscribers",
    async () => {
      const phases = [];
      const unsubscribe = live.onUpdate(api.e2eQueries.get, alice, (row) => {
        if (row && phases.at(-1) !== row.phase) phases.push(row.phase);
      });
      const sandbox = await create(alice.ownerId, alice.key);
      await sleep(500);
      unsubscribe();
      assert.equal(sandbox.phase, "ready");
      assert.ok(sandbox.sessionId);
      assert.deepEqual(phases, ["provisioning", "ready"]);
    },
  );

  await scenario("exec runs shell strings and argv", async () => {
    const shell = await exec(alice, "echo hello && uname -m && exit 3");
    assert.equal(shell.exitCode, 3);
    assert.match(shell.stdout, /^hello\n(x86_64|aarch64)\n$/);
    const argv = await exec(alice, ["printf", "%s", "a b"]);
    assert.equal(argv.stdout, "a b");
    assert.equal((await exec(alice, "echo oops >&2")).stderr, "oops\n");
  });

  await scenario(
    "concurrent creates for one identity make one sandbox",
    async () => {
      const carol = owner("carol");
      const rows = await Promise.all(
        [1, 2, 3, 4, 5].map(() => create(carol, "main")),
      );
      assert.equal(new Set(rows.map((r) => r.sessionId)).size, 1);
      const sessions = await liveSessions(
        await adoptionTag(namespace, carol, "main"),
      );
      assert.equal(
        sessions.length,
        1,
        `expected 1 live session, got ${sessions.map((s) => s.id)}`,
      );
      await act("destroy", { ownerId: carol, key: "main" });
    },
  );

  await scenario("create adopts an orphan from a crashed create", async () => {
    const dave = owner("dave");
    const tag = await adoptionTag(namespace, dave, "main");
    const orphan = await sdk.create({
      tags: [tag, runTag],
      maxDurationMs: 15 * 60_000,
    });
    const sandbox = await create(dave, "main");
    assert.equal(sandbox.sessionId, orphan.id);
    assert.equal((await liveSessions(tag)).length, 1);
    await act("destroy", { ownerId: dave, key: "main" });
  });

  await scenario(
    "a bad API key fails create and records the error",
    async () => {
      const who = { ownerId: owner("frank"), key: "main" };
      await assert.rejects(
        act("createWithBadKey", who),
        codeIs("unauthenticated"),
      );
      const row = await get(who.ownerId, who.key);
      assert.equal(row.phase, "error");
      assert.equal(row.lastError.code, "unauthenticated");
    },
  );

  await scenario("owners cannot see each other's sandboxes", async () => {
    assert.equal(await get(owner("mallory"), "main"), null);
    assert.ok(await get(alice.ownerId, alice.key));
  });

  await scenario("files round-trip as text and bytes", async () => {
    await act("writeFile", {
      ...alice,
      path: "/home/tenki/hello.txt",
      data: "héllo\n",
    });
    assert.equal(
      await act("readText", { ...alice, path: "/home/tenki/hello.txt" }),
      "héllo\n",
    );
    const bytes = new Uint8Array(256).map((_, i) => i);
    await act("writeFile", {
      ...alice,
      path: "/home/tenki/all.bin",
      data: bytes.buffer,
    });
    const back = new Uint8Array(
      await act("readBytes", { ...alice, path: "/home/tenki/all.bin" }),
    );
    assert.deepEqual([...back], [...bytes]);
    await assert.rejects(
      act("readText", { ...alice, path: "/home/tenki/nope" }),
      codeIs("file_not_found"),
    );
  });

  await scenario(
    "spawned processes outlive the action and report exit codes",
    async () => {
      const quick = await act("spawn", {
        ...alice,
        command: "echo from-bg; exit 4",
      });
      const done = await until("quick process exit", async () => {
        const st = await act("processStatus", {
          ...alice,
          processId: quick.processId,
        });
        return st.state === "exited" && st;
      });
      assert.equal(done.exitCode, 4);
      assert.equal(done.output, "from-bg\n");

      server = await act("spawn", {
        ...alice,
        command:
          "cd ~ && echo serving > index.html && exec python3 -m http.server 8080",
      });
      await until(
        "server running",
        async () =>
          (await exec(alice, "curl -sf localhost:8080/")).exitCode === 0,
      );
    },
  );

  await scenario("exposePort serves the spawned server publicly", async () => {
    const preview = await act("exposePort", { ...alice, port: 8080 });
    assert.match(preview.url, /^https:\/\//);
    const body = await until(
      "preview URL to serve",
      async () => {
        const res = await fetch(preview.url);
        return res.ok && (await res.text());
      },
      90_000,
    );
    assert.equal(body, "serving\n");
    assert.deepEqual(
      (await get(alice.ownerId, alice.key)).previews.map((p) => p.port),
      [8080],
    );
  });

  await scenario("extend pushes the deadline out", async () => {
    const before = (await get(alice.ownerId, alice.key)).remote.timeoutAt;
    const after = await act("extend", { ...alice, additionalMs: 10 * 60_000 });
    assert.ok(
      after.remote.timeoutAt >= before + 9 * 60_000,
      `${before} -> ${after.remote.timeoutAt}`,
    );
  });

  await scenario(
    "pause keeps files and processes; resume makes it usable again",
    async () => {
      assert.equal((await act("pause", alice)).phase, "paused");
      await assert.rejects(exec(alice, "true"), codeIs("not_ready"));
      assert.equal((await act("resume", alice)).phase, "ready");
      assert.equal(
        await act("readText", { ...alice, path: "/home/tenki/hello.txt" }),
        "héllo\n",
      );
      assert.equal(
        (await act("processStatus", { ...alice, processId: server.processId }))
          .state,
        "running",
      );
    },
  );

  await scenario("kill stops a background process", async () => {
    assert.deepEqual(
      await act("kill", { ...alice, processId: server.processId }),
      { signaled: true },
    );
    const st = await until("server to stop", async () => {
      const s = await act("processStatus", {
        ...alice,
        processId: server.processId,
      });
      return s.state !== "running" && s;
    });
    assert.equal(st.state, "killed");
  });

  await scenario(
    "fork copies the sandbox into an independent one",
    async () => {
      const forked = await act("fork", {
        ownerId: alice.ownerId,
        from: "main",
        to: "fork",
      });
      assert.equal(forked.phase, "ready");
      assert.notEqual(
        forked.sessionId,
        (await get(alice.ownerId, alice.key)).sessionId,
      );
      const fork = { ownerId: alice.ownerId, key: "fork" };
      assert.equal(
        await act("readText", { ...fork, path: "/home/tenki/hello.txt" }),
        "héllo\n",
      );
      await act("writeFile", {
        ...fork,
        path: "/home/tenki/hello.txt",
        data: "changed in fork\n",
      });
      assert.equal(
        await act("readText", { ...alice, path: "/home/tenki/hello.txt" }),
        "héllo\n",
      );
      await act("destroy", fork);
    },
  );

  await scenario(
    "reconcile catches rows up with sandboxes that ended elsewhere",
    async () => {
      const erin = { ownerId: owner("erin"), key: "main" };
      const row = await create(erin.ownerId, erin.key);
      await (await sdk.get(row.sessionId)).close();
      const out = await act("reconcile", {});
      assert.ok(out.checked >= 1, JSON.stringify(out));
      assert.equal((await get(erin.ownerId, erin.key)).phase, "terminated");
    },
  );

  if (slow) {
    await scenario(
      "a sandbox that reaches its deadline is caught up by reconcile",
      async () => {
        const gina = { ownerId: owner("gina"), key: "main" };
        const row = await act("createShortLived", {
          ...gina,
          maxDurationMs: 60_000,
          tags: [runTag],
        });
        await exec(gina, "true");
        await until(
          "the deadline to pass",
          async () => {
            const s = await sdk.get(row.sessionId);
            return !isLive(s) || s.state === "PAUSED";
          },
          5 * 60_000,
        );
        assert.equal(
          (await get(gina.ownerId, gina.key)).phase,
          "ready",
          "row should be stale before reconcile",
        );
        await act("reconcile", {});
        const after = await get(gina.ownerId, gina.key);
        assert.ok(["paused", "terminated"].includes(after.phase), after.phase);
        await assert.rejects(exec(gina, "true"), codeIs("not_ready"));
        await act("destroy", gina);
      },
    );
  }

  await scenario("destroy terminates, and the key can be reused", async () => {
    const before = await get(alice.ownerId, alice.key);
    assert.equal((await act("destroy", alice)).phase, "terminated");
    assert.equal(
      (
        await liveSessions(
          await adoptionTag(namespace, alice.ownerId, alice.key),
        )
      ).length,
      0,
    );
    const again = await create(alice.ownerId, alice.key);
    assert.equal(again.phase, "ready");
    assert.notEqual(again.sessionId, before.sessionId);
    await act("destroy", alice);
  });

  await scenario("exec on a terminated sandbox reports not_ready", async () => {
    await assert.rejects(exec(alice, "true"), codeIs("not_ready"));
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
