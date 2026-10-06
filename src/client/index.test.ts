// @vitest-environment node
import { anyApi, actionGeneric, type ApiFromModules } from "convex/server";
import { ConvexError, v } from "convex/values";
import { beforeEach, describe, expect, test } from "vitest";
import { MAX_EXEC_TIMEOUT_MS, Tenki } from "./index.js";
import {
  adoptionTag,
  cappedArgv,
  describeError,
  SPAWN_SCRIPT,
} from "./internal.js";
import { FakeSdk, sdkError, text, type FakeSession } from "./fake.test.js";
import { components, initConvexTest } from "./setup.test.js";

let fake = new FakeSdk();
const NS = "https://test.convex.cloud";
const tenki = (namespace = NS) =>
  new Tenki(components.tenki, { client: fake, namespace });

const identity = {
  ownerId: v.string(),
  key: v.string(),
  namespace: v.optional(v.string()),
};

export const create = actionGeneric({
  args: { ...identity, tags: v.optional(v.array(v.string())) },
  handler: async (ctx, { namespace, tags, ...args }) =>
    await tenki(namespace).create(ctx, { ...args, options: { tags } }),
});
export const exec = actionGeneric({
  args: {
    ...identity,
    command: v.any(),
    timeoutMs: v.optional(v.number()),
    maxOutputBytes: v.optional(v.number()),
  },
  handler: async (ctx, { namespace, ...args }) =>
    await tenki(namespace).exec(ctx, args),
});
export const refresh = actionGeneric({
  args: identity,
  handler: async (ctx, { namespace, ...args }) =>
    await tenki(namespace).refresh(ctx, args),
});
export const destroy = actionGeneric({
  args: identity,
  handler: async (ctx, { namespace, ...args }) =>
    await tenki(namespace).destroy(ctx, args),
});

const capped = () =>
  new Tenki(components.tenki, {
    client: fake,
    namespace: NS,
    maxActiveSandboxes: 1,
  });

export const createCapped = actionGeneric({
  args: { ownerId: v.string(), key: v.string() },
  handler: async (ctx, args) => await capped().create(ctx, args),
});

export const forkCapped = actionGeneric({
  args: { ownerId: v.string(), from: v.string(), to: v.string() },
  handler: async (ctx, args) => await capped().fork(ctx, args),
});

export const op = actionGeneric({
  args: { method: v.string(), args: v.any(), config: v.optional(v.any()) },
  handler: async (ctx, { method, args, config }) => {
    const client = new Tenki(components.tenki, {
      client: fake,
      namespace: NS,
      ...config,
    }) as unknown as Record<
      string,
      (ctx: unknown, args: unknown) => Promise<unknown>
    >;
    return await client[method](ctx, args);
  },
});

const api = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      create: typeof create;
      exec: typeof exec;
      refresh: typeof refresh;
      destroy: typeof destroy;
      op: typeof op;
      createCapped: typeof createCapped;
      forkCapped: typeof forkCapped;
    };
  }>
)["index.test"];

const alice = { ownerId: "user_alice", key: "main" };

async function convexErrorData(promise: Promise<unknown>) {
  const err = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ConvexError);
  return (err as ConvexError<{ code: string }>).data;
}

beforeEach(() => {
  fake = new FakeSdk();
});

describe("create", () => {
  test("creates a tagged session and records it", async () => {
    const t = initConvexTest();
    const sandbox = await t.action(api.create, { ...alice, tags: ["team-a"] });
    expect(sandbox.phase).toBe("ready");
    expect(sandbox.remote?.state).toBe("RUNNING");
    expect(fake.creates).toHaveLength(1);
    const tag = await adoptionTag(NS, alice.ownerId, alice.key);
    expect(fake.creates[0].tags).toEqual([tag, "team-a"]);
    expect(fake.creates[0].metadata).toMatchObject({
      convex_owner_id: "user_alice",
      convex_key: "main",
    });
    expect(fake.sessions.get(sandbox.sessionId!)).toBeDefined();
  });

  test("is idempotent for the same identity", async () => {
    const t = initConvexTest();
    const first = await t.action(api.create, alice);
    const second = await t.action(api.create, alice);
    expect(second.sessionId).toBe(first.sessionId);
    expect(fake.creates).toHaveLength(1);
  });

  test("concurrent creates produce one session", async () => {
    const t = initConvexTest();
    fake.createDelayMs = 50;
    const results = await Promise.all(
      [1, 2, 3].map(() => t.action(api.create, alice)),
    );
    expect(new Set(results.map((r) => r.sessionId)).size).toBe(1);
    expect(fake.creates).toHaveLength(1);
  });

  test("adopts a session left by a crashed create", async () => {
    const t = initConvexTest();
    const orphan = fake.seed([await adoptionTag(NS, alice.ownerId, alice.key)]);
    const sandbox = await t.action(api.create, alice);
    expect(sandbox.sessionId).toBe(orphan.id);
    expect(fake.creates).toHaveLength(0);
  });

  test("waits for an adopted session that is still creating", async () => {
    const t = initConvexTest();
    const orphan = fake.seed(
      [await adoptionTag(NS, alice.ownerId, alice.key)],
      "CREATING",
    );
    const sandbox = await t.action(api.create, alice);
    expect(sandbox.sessionId).toBe(orphan.id);
    expect(sandbox.phase).toBe("ready");
  });

  test("a racing creator yields to the oldest session", async () => {
    const t = initConvexTest();
    const tag = await adoptionTag(NS, alice.ownerId, alice.key);
    const olderId = fake.nextId();
    const realCreate = fake.create.bind(fake);
    fake.create = async (options) => {
      fake.seed([tag], "RUNNING", olderId);
      return await realCreate(options);
    };
    const sandbox = await t.action(api.create, alice);
    expect(sandbox.sessionId).toBe(olderId);
    const ours = [...fake.sessions.values()].find((s) => s.id !== olderId)!;
    expect(ours.state).toBe("TERMINATING");
  });

  test("records failures and lets the next create retry", async () => {
    const t = initConvexTest();
    fake.failCreate = sdkError("QuotaExceededError", "out of credits");
    expect(await convexErrorData(t.action(api.create, alice))).toMatchObject({
      code: "quota_exceeded",
    });
    const failed = await t.query(components.tenki.sandboxes.get, alice);
    expect(failed?.phase).toBe("error");
    expect(failed?.lastError).toMatchObject({
      code: "quota_exceeded",
      message: "out of credits",
    });

    fake.failCreate = undefined;
    const sandbox = await t.action(api.create, alice);
    expect(sandbox.phase).toBe("ready");
    expect(sandbox.lastError).toBeUndefined();
  });

  test("an empty workspace balance is reported as insufficient_credits", async () => {
    const t = initConvexTest();
    fake.failCreate = sdkError(
      "InvalidStateError",
      "[failed_precondition] workspace balance is empty; top up to start a sandbox",
    );
    expect(await convexErrorData(t.action(api.create, alice))).toMatchObject({
      code: "insufficient_credits",
    });
    expect((await row(t))?.lastError?.code).toBe("insufficient_credits");
  });

  test("namespaces keep deployments from adopting each other's sessions", async () => {
    expect(await adoptionTag("a", "u", "k")).not.toBe(
      await adoptionTag("b", "u", "k"),
    );
    const t = initConvexTest();
    await t.action(api.create, {
      ...alice,
      namespace: "https://dev.convex.cloud",
    });
    await t.action(api.destroy, {
      ...alice,
      namespace: "https://dev.convex.cloud",
    });
    await t.action(api.create, {
      ...alice,
      namespace: "https://prod.convex.cloud",
    });
    expect(fake.creates).toHaveLength(2);
    expect(fake.creates[0].tags![0]).not.toBe(fake.creates[1].tags![0]);
  });

  test("tags fit Tenki's tag rules", async () => {
    const tag = await adoptionTag(
      NS,
      "user_" + "x".repeat(200),
      "k".repeat(200),
    );
    expect(tag).toMatch(/^[a-z0-9][a-z0-9_:.-]*$/);
    expect(tag.length).toBeLessThanOrEqual(32);
  });
});

describe("exec", () => {
  test("runs strings under bash and returns text output", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    const result = await t.action(api.exec, {
      ...alice,
      command: "echo ok && pwd",
    });
    expect(result).toMatchObject({
      exitCode: 0,
      stdout: "ok\n",
      stdoutTruncated: false,
      timedOut: false,
    });
    expect(fake.sessions.get(sessionId!)!.argv[0]).toEqual(
      cappedArgv(["bash", "-lc", "echo ok && pwd"], (1 << 20) + 1),
    );
  });

  test("passes argv through and caps the timeout", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    await t.action(api.exec, {
      ...alice,
      command: ["ls", "-la"],
      timeoutMs: 60 * 60_000,
      maxOutputBytes: 10,
    });
    expect(fake.sessions.get(sessionId!)!.argv[0]).toEqual(
      cappedArgv(["ls", "-la"], 11),
    );
    expect(fake.execOptions[0]).toMatchObject({
      timeoutMs: MAX_EXEC_TIMEOUT_MS,
    });
    await t.action(api.exec, { ...alice, command: ["ls"], timeoutMs: 0 });
    expect(fake.execOptions[1]).toMatchObject({
      timeoutMs: MAX_EXEC_TIMEOUT_MS,
    });
  });

  test("truncates large output and flags timeouts", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    fake.execResult = {
      ...fake.execResult,
      stdout: new Uint8Array(100).fill(97),
      reason: "timeout",
      exitCode: -1,
    };
    const result = await t.action(api.exec, {
      ...alice,
      command: "yes",
      maxOutputBytes: 10,
    });
    expect(result).toMatchObject({
      stdout: "a".repeat(10),
      stdoutTruncated: true,
      timedOut: true,
    });
  });

  test("fails fast when the sandbox is missing or not ready", async () => {
    const t = initConvexTest();
    expect(
      await convexErrorData(t.action(api.exec, { ...alice, command: "true" })),
    ).toMatchObject({
      code: "not_found",
    });
    const { sessionId } = await t.action(api.create, alice);
    fake.sessions.get(sessionId!)!.state = "PAUSED";
    await t.action(api.refresh, alice);
    expect(
      await convexErrorData(t.action(api.exec, { ...alice, command: "true" })),
    ).toMatchObject({
      code: "not_ready",
      phase: "paused",
    });
  });

  test("marks the row terminated when the session is gone", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    fake.execError = sdkError("SessionTerminatedError");
    expect(
      await convexErrorData(t.action(api.exec, { ...alice, command: "true" })),
    ).toMatchObject({
      code: "terminated",
    });
    expect((await t.query(components.tenki.sandboxes.get, alice))?.phase).toBe(
      "terminated",
    );
  });
});

describe("refresh and destroy", () => {
  test("refresh mirrors the remote state", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    fake.sessions.get(sessionId!)!.state = "PAUSED";
    expect((await t.action(api.refresh, alice))?.phase).toBe("paused");
    fake.sessions.delete(sessionId!);
    expect((await t.action(api.refresh, alice))?.phase).toBe("terminated");
  });

  test("destroy terminates the session and any orphans, then allows re-create", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    const orphan = fake.seed([await adoptionTag(NS, alice.ownerId, alice.key)]);
    const destroyed = await t.action(api.destroy, alice);
    expect(destroyed?.phase).toBe("terminated");
    expect(fake.sessions.get(sessionId!)!.state).toBe("TERMINATING");
    expect(orphan.state).toBe("TERMINATING");

    const again = await t.action(api.create, alice);
    expect(again.phase).toBe("ready");
    expect(again.sessionId).not.toBe(sessionId);
  });

  test("destroy of an unknown identity is a no-op", async () => {
    const t = initConvexTest();
    expect(await t.action(api.destroy, alice)).toBeNull();
  });
});

const call = (
  t: ReturnType<typeof initConvexTest>,
  method: string,
  args: Record<string, unknown> = {},
  config?: Record<string, unknown>,
) =>
  t.action(api.op, {
    method,
    args: { ...alice, ...args },
    config,
  }) as Promise<any>;
const row = (t: ReturnType<typeof initConvexTest>) =>
  t.query(components.tenki.sandboxes.get, alice);
const reply = (stdout: string, exitCode = 0) => ({
  exitCode,
  stdout: text(stdout),
  stderr: new Uint8Array(),
  reason: "exit",
  durationMs: 1,
});

describe("pause and resume", () => {
  test("pause waits for paused; resume waits until commands run", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    expect((await call(t, "pause"))?.phase).toBe("paused");
    expect(await convexErrorData(call(t, "pause"))).toMatchObject({
      code: "not_ready",
      phase: "paused",
    });

    let probes = 0;
    fake.onExec = (argv) =>
      argv[0] === "true" && ++probes === 1
        ? sdkError("StreamClosedError")
        : reply("");
    const resumed = await call(t, "resume");
    expect(resumed.phase).toBe("ready");
    expect(probes).toBe(2);
  });

  test("pause without waiting reports pausing until a refresh sees paused", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    expect((await call(t, "pause", { wait: false }))?.phase).toBe("pausing");
    fake.sessions.get(sessionId!)!.state = "PAUSED";
    expect((await t.action(api.refresh, alice))?.phase).toBe("paused");
  });

  test("a sandbox paused behind the row's back is re-synced on the next call", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    fake.sessions.get(sessionId!)!.state = "PAUSED";
    fake.execError = sdkError("InvalidStateError", "session is paused");
    expect(
      await convexErrorData(t.action(api.exec, { ...alice, command: "true" })),
    ).toMatchObject({
      code: "invalid_state",
    });
    expect((await row(t))?.phase).toBe("paused");
  });
});

describe("background processes", () => {
  test("spawn passes the command through env, never the script", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    fake.onExec = () => reply("4242\n");
    const spawned = await call(t, "spawn", {
      command: "python3 -m http.server 8080 'quoted; $(rm -rf /)'",
    });
    expect(spawned.pid).toBe(4242);
    expect(spawned.processId).toMatch(/^[a-z0-9]{16}$/);
    const options = fake.execOptions.at(-1)!;
    expect(options.env).toMatchObject({
      TENKI_CVX_ID: spawned.processId,
      TENKI_CVX_CMD: "python3 -m http.server 8080 'quoted; $(rm -rf /)'",
    });
    const session = [...fake.sessions.values()][0];
    expect(session.argv.at(-1)).toEqual(["bash", "-c", SPAWN_SCRIPT]);
  });

  test("processStatus parses state, exit code and truncation", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    fake.onExec = () => reply("exited 3 5\nhello");
    expect(
      await call(t, "processStatus", { processId: "abcdef0123456789" }),
    ).toEqual({
      state: "exited",
      exitCode: 3,
      output: "hello",
      outputTruncated: false,
    });
    fake.onExec = () => reply("running - 100\nlast bytes");
    expect(
      await call(t, "processStatus", {
        processId: "abcdef0123456789",
        tailBytes: 10,
      }),
    ).toMatchObject({
      state: "running",
      outputTruncated: true,
    });
    fake.onExec = () => reply("missing\n");
    expect(
      await call(t, "processStatus", { processId: "abcdef0123456789" }),
    ).toMatchObject({ state: "missing" });
  });

  test("rejects process ids that could escape the process directory", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    await expect(
      call(t, "processStatus", { processId: "../../etc" }),
    ).rejects.toThrow(/invalid processId/);
  });

  test("kill sends an allowed signal", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    fake.onExec = () => reply("signaled\n");
    expect(await call(t, "kill", { processId: "abcdef0123456789" })).toEqual({
      signaled: true,
    });
    expect(fake.execOptions.at(-1)!.env).toMatchObject({
      TENKI_CVX_SIGNAL: "TERM",
    });
    expect(
      await convexErrorData(
        call(t, "kill", { processId: "abcdef0123456789", signal: "STOP" }),
      ),
    ).toMatchObject({
      code: "invalid_argument",
    });
  });
});

describe("files, ports and lifetime", () => {
  test("files round-trip as text and bytes", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    await call(t, "writeFile", { path: "/home/tenki/a.txt", data: "héllo" });
    expect(await call(t, "readFile", { path: "/home/tenki/a.txt" })).toBe(
      "héllo",
    );
    await call(t, "writeFile", {
      path: "/home/tenki/b.bin",
      data: new Uint8Array([0, 255, 7]).buffer,
    });
    const bytes = await call(t, "readFile", {
      path: "/home/tenki/b.bin",
      encoding: "bytes",
    });
    expect([...new Uint8Array(bytes)]).toEqual([0, 255, 7]);
    expect(
      await convexErrorData(call(t, "readFile", { path: "/nope" })),
    ).toMatchObject({ code: "file_not_found" });
  });

  test("exposed ports are recorded per port and cleared on re-create", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    await call(t, "exposePort", { port: 8080, slug: "a" });
    await call(t, "exposePort", { port: 3000 });
    await call(t, "exposePort", { port: 8080, slug: "b" });
    expect((await row(t))?.previews).toEqual([
      { port: 3000, url: "https://p-3000.preview.test" },
      { port: 8080, url: "https://b-8080.preview.test" },
    ]);
    await t.action(api.destroy, alice);
    expect((await row(t))?.previews).toBeUndefined();
    expect((await t.action(api.create, alice)).previews).toBeUndefined();
  });

  test("extend pushes the deadline out", async () => {
    const t = initConvexTest();
    const before = (await t.action(api.create, alice)).remote!.timeoutAt!;
    const after = await call(t, "extend", { additionalMs: 60_000 });
    expect(after.remote.timeoutAt).toBe(before + 60_000);
  });
});

describe("snapshots and fork", () => {
  test("snapshot is recorded; fork creates the target from it", async () => {
    const t = initConvexTest();
    const source = await t.action(api.create, alice);
    const forked = await call(t, "fork", {
      from: "main",
      to: "experiment",
      name: "before-refactor",
    });
    expect(fake.snapshots).toEqual([
      {
        sessionId: source.sessionId,
        options: { name: "before-refactor", expiresAt: expect.any(Date) },
      },
    ]);
    expect(fake.creates.at(-1)).toMatchObject({ snapshotId: "snap-1" });
    expect(forked).toMatchObject({ key: "experiment", phase: "ready" });
    expect(forked.sessionId).not.toBe(source.sessionId);
    expect(await call(t, "listSnapshots")).toMatchObject([
      { snapshotId: "snap-1", name: "before-refactor" },
    ]);
  });
});

describe("reconcile", () => {
  test("catches rows up with sandboxes that ended", async () => {
    const t = initConvexTest();
    const a = await t.action(api.create, alice);
    await t.action(api.create, { ownerId: "user_bob", key: "main" });
    fake.sessions.delete(a.sessionId!);
    expect(await t.action(api.op, { method: "reconcile", args: {} })).toEqual({
      checked: 2,
      changed: 1,
    });
    expect((await row(t))?.phase).toBe("terminated");
  });
});

describe("review fixes", () => {
  test("a create that fails after the session exists closes it", async () => {
    const t = initConvexTest();
    fake.failCreateAfterSession = "WaitReadyFailedError";
    expect(await convexErrorData(t.action(api.create, alice))).toMatchObject({
      code: "not_ready",
    });
    const [stuck] = [...fake.sessions.values()];
    expect(stuck.state).toBe("TERMINATING");
    expect((await row(t))?.phase).toBe("error");

    fake.failCreateAfterSession = undefined;
    const sandbox = await t.action(api.create, alice);
    expect(sandbox.phase).toBe("ready");
    expect(sandbox.sessionId).not.toBe(stuck.id);
  });

  test("an adopted session that never gets ready is closed, not re-adopted forever", async () => {
    const t = initConvexTest();
    const stuck = fake.seed(
      [await adoptionTag(NS, alice.ownerId, alice.key)],
      "CREATING",
    );
    fake.failWaitReady = new Error(
      `timeout waiting for session ${stuck.id} to become ready`,
    );
    await expect(t.action(api.create, alice)).rejects.toThrow();
    expect(stuck.state).toBe("TERMINATING");

    fake.failWaitReady = undefined;
    const sandbox = await t.action(api.create, alice);
    expect(sandbox.sessionId).not.toBe(stuck.id);
  });

  test("a guest shutdown is resumable, not terminated", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    fake.sessions.get(sessionId!)!.state = "USER_SHUTDOWN";
    expect((await t.action(api.refresh, alice))?.phase).toBe("paused");
    expect((await t.action(api.create, alice)).sessionId).toBe(sessionId);
    await t.action(api.destroy, alice);
    expect(fake.sessions.get(sessionId!)!.state).toBe("TERMINATING");
  });

  test("a failed pause re-syncs the row instead of leaving it pausing", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    fake.failPause = sdkError(
      "PauseFailedError",
      "pause failed: session reverted to RUNNING",
    );
    expect(await convexErrorData(call(t, "pause"))).toMatchObject({
      code: "pause_failed",
    });
    expect((await row(t))?.phase).toBe("ready");
  });

  test("a failed resume re-syncs the row instead of leaving it resuming", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    await call(t, "pause");
    fake.failResume = sdkError("ResumeFailedError", "resume failed");
    expect(await convexErrorData(call(t, "resume"))).toMatchObject({
      code: "resume_failed",
    });
    expect((await row(t))?.phase).toBe("paused");
  });

  test("a concurrent create surfaces the lease holder's failure", async () => {
    const t = initConvexTest();
    fake.createDelayMs = 50;
    fake.failCreate = sdkError("QuotaExceededError", "out of quota");
    const results = await Promise.allSettled(
      [1, 2].map(() => t.action(api.create, alice)),
    );
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    for (const r of results) {
      expect(
        ((r as PromiseRejectedResult).reason as ConvexError<{ code: string }>)
          .data.code,
      ).toBe("quota_exceeded");
    }
  });

  test("maxActiveSandboxes caps creates and forks across owners, ignoring paused ones", async () => {
    const t = initConvexTest();
    await t.action(api.createCapped, alice);
    expect(
      await convexErrorData(
        t.action(api.createCapped, { ownerId: "user_bob", key: "main" }),
      ),
    ).toMatchObject({ code: "capacity_exceeded" });
    expect(
      await convexErrorData(
        t.action(api.forkCapped, {
          ownerId: alice.ownerId,
          from: "main",
          to: "fork",
        }),
      ),
    ).toMatchObject({ code: "capacity_exceeded" });

    await call(t, "pause");
    expect(
      (await t.action(api.createCapped, { ownerId: "user_bob", key: "main" }))
        .phase,
    ).toBe("ready");
  });

  test("reconcile rotates past rows that keep failing", async () => {
    const t = initConvexTest();
    const bad = await t.action(api.create, {
      ownerId: "user_bad",
      key: "main",
    });
    await t.action(api.create, alice);
    const realGet = fake.get.bind(fake);
    // Rows touched in the same millisecond tie on updatedAt; real runs are minutes apart.
    const reconcileOne = async () => {
      await new Promise((r) => setTimeout(r, 5));
      await t.action(api.op, { method: "reconcile", args: { limit: 1 } });
    };
    fake.get = async (id) =>
      id === bad.sessionId
        ? Promise.reject(sdkError("PermissionDeniedError"))
        : realGet(id);
    await reconcileOne();
    await reconcileOne();
    const stale = await t.query(components.tenki.sandboxes.stale, { limit: 1 });
    expect(stale[0].ownerId).toBe("user_bad");
    fake.sessions.get((await row(t))!.sessionId!)!.state = "PAUSED";
    await reconcileOne();
    await reconcileOne();
    expect((await row(t))?.phase).toBe("paused");
  });
});

/** Makes a fake session resume the way Tenki does: only from PAUSED, and not instantly. */
function resumeLikeTenki(s: FakeSession, resumeMs = 100) {
  const wait = async (state: string) => {
    for (let i = 0; i < 100 && s.state !== state; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    if (s.state !== state) throw new Error(`timeout waiting for ${state}`);
  };
  s.resume = async () => {
    if (s.state === "RUNNING") return;
    if (s.state !== "PAUSED") {
      throw sdkError(
        "InvalidStateError",
        `[failed_precondition] cannot resume session in current state ${s.state}`,
      );
    }
    s.state = "RESUMING";
    setTimeout(() => (s.state = "RUNNING"), resumeMs);
  };
  s.waitResumed = async () => await wait("RUNNING");
  s.waitPaused = async () => await wait("PAUSED");
}

describe("create on an existing sandbox", () => {
  test("concurrent creates on a paused sandbox both get it ready", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    await call(t, "pause");
    resumeLikeTenki(fake.sessions.get(sessionId!)!);
    const results = await Promise.all([
      t.action(api.create, alice),
      t.action(api.create, alice),
    ]);
    expect(results.map((r) => [r.phase, r.sessionId])).toEqual([
      ["ready", sessionId],
      ["ready", sessionId],
    ]);
  });

  test("a create while Tenki is still pausing at the deadline waits and resumes", async () => {
    const t = initConvexTest();
    fake.lifetimeMs = 1;
    const { sessionId } = await t.action(api.create, alice);
    await new Promise((r) => setTimeout(r, 5));
    const s = fake.sessions.get(sessionId!)!;
    resumeLikeTenki(s);
    s.state = "PAUSING";
    setTimeout(() => (s.state = "PAUSED"), 300);
    expect(await t.action(api.create, alice)).toMatchObject({
      phase: "ready",
      sessionId,
    });
    expect(s.state).toBe("RUNNING");
  });

  test("a resume whose first request was ambiguous still finishes", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    await call(t, "pause");
    const s = fake.sessions.get(sessionId!)!;
    // Slower than the first retry, so the retry finds the session still RESUMING.
    resumeLikeTenki(s, 3000);
    const resume = s.resume;
    let calls = 0;
    s.resume = async () => {
      await resume();
      // Tenki committed RESUMING, then lost track of the dispatch.
      if (++calls === 1)
        throw sdkError("SandboxError", "[unavailable] resume dispatch failed");
    };
    expect((await call(t, "resume")).phase).toBe("ready");
    expect((await row(t))?.phase).toBe("ready");
  }, 15_000);

  test("resumes a paused sandbox, or returns it as is with resume: false", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    await call(t, "pause");
    expect((await call(t, "create", { resume: false })).phase).toBe("paused");
    expect(await call(t, "create")).toMatchObject({
      phase: "ready",
      sessionId,
    });
    expect(fake.creates).toHaveLength(1);
  });

  test("resumes a sandbox Tenki paused at its deadline, retrying while unavailable", async () => {
    const t = initConvexTest();
    fake.lifetimeMs = 1;
    const { sessionId } = await t.action(api.create, alice);
    await new Promise((r) => setTimeout(r, 5));
    fake.sessions.get(sessionId!)!.state = "PAUSED";
    fake.resumeErrors = [
      sdkError(
        "SandboxError",
        "[unavailable] paused source is still being torn down, retry shortly",
      ),
    ];
    expect(await t.action(api.create, alice)).toMatchObject({
      phase: "ready",
      sessionId,
    });
    expect(fake.resumeErrors).toHaveLength(0);
    expect(fake.creates).toHaveLength(1);
  });

  test("replaces a sandbox that ended behind the row's back", async () => {
    const t = initConvexTest();
    const first = await t.action(api.create, alice);
    await call(t, "pause");
    fake.sessions.delete(first.sessionId!);
    const again = await t.action(api.create, alice);
    expect(again.phase).toBe("ready");
    expect(again.sessionId).not.toBe(first.sessionId);
    expect(fake.creates).toHaveLength(2);
  });

  test("tags in the reserved cvx: prefix are refused", async () => {
    const t = initConvexTest();
    // Tenki trims and lowercases tags, so padded forms would become cvx: tags too.
    for (const tag of [
      "CVX:0123",
      " cvx:0123",
      "\tcvx:0123",
      " cvx:0123",
      "\u0085cvx:0123",
    ]) {
      expect(
        await convexErrorData(t.action(api.create, { ...alice, tags: [tag] })),
      ).toMatchObject({ code: "invalid_argument" });
    }
    expect(await row(t)).toBeNull();
    expect(
      (
        await t.action(api.create, {
          ...alice,
          tags: ["Team-A", "cvx-e2e:run1"],
        })
      ).phase,
    ).toBe("ready");
    expect(fake.creates[0].tags).toContain("Team-A");
  });

  test("destroy during a create cancels it and closes its session", async () => {
    const t = initConvexTest();
    let destroyed: unknown;
    fake.onCreate = async () => {
      destroyed = await t.action(api.destroy, alice);
    };
    expect(await convexErrorData(t.action(api.create, alice))).toMatchObject({
      code: "terminated",
    });
    expect(destroyed).toMatchObject({ phase: "terminated" });
    expect([...fake.sessions.values()].map((s) => s.state)).toEqual([
      "TERMINATING",
    ]);
    expect((await row(t))?.phase).toBe("terminated");

    fake.onCreate = undefined;
    expect((await t.action(api.create, alice)).phase).toBe("ready");
  });

  test("a create waiting on one that destroy cancels gets a new sandbox", async () => {
    const t = initConvexTest();
    fake.createDelayMs = 200;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const holder = convexErrorData(t.action(api.create, alice));
    await sleep(30);
    const waiter = t.action(api.create, alice);
    await sleep(30);
    await t.action(api.destroy, alice);
    expect(await holder).toMatchObject({ code: "terminated" });
    const sandbox = await waiter;
    expect(sandbox.phase).toBe("ready");
    expect(fake.sessions.get(sandbox.sessionId!)?.state).toBe("RUNNING");
  });
});

describe("limits", () => {
  const capped = { maxActiveSandboxes: 1 };

  test("resuming a paused sandbox counts against maxActiveSandboxes", async () => {
    const t = initConvexTest();
    await call(t, "create", {}, capped);
    await call(t, "pause", {}, capped);
    await call(t, "create", { ownerId: "user_bob" }, capped);
    expect(await convexErrorData(call(t, "resume", {}, capped))).toMatchObject({
      code: "capacity_exceeded",
    });
    expect(await convexErrorData(call(t, "create", {}, capped))).toMatchObject({
      code: "capacity_exceeded",
    });
    expect((await row(t))?.phase).toBe("paused");
  });

  test("readFile refuses files over maxBytes before reading them", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    await call(t, "writeFile", { path: "/big", data: "x".repeat(20) });
    expect(
      await convexErrorData(
        call(t, "readFile", { path: "/big", maxBytes: 10 }),
      ),
    ).toMatchObject({ code: "file_too_large", size: 20 });
  });
});

describe("fork", () => {
  test("refuses a live target and expires its snapshot", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    await call(t, "fork", { from: "main", to: "fork" });
    expect(
      fake.snapshots[0].options!.expiresAt!.getTime() - Date.now(),
    ).toBeGreaterThan(50 * 60_000);
    expect(
      await convexErrorData(call(t, "fork", { from: "main", to: "fork" })),
    ).toMatchObject({ code: "already_exists" });
    expect(fake.snapshots).toHaveLength(1);

    await call(t, "destroy", { key: "fork" });
    expect((await call(t, "fork", { from: "main", to: "fork" })).phase).toBe(
      "ready",
    );
    expect(fake.snapshots).toHaveLength(2);
  });

  test("a snapshot restore takes the snapshot's size, not the defaults", async () => {
    const t = initConvexTest();
    const config = {
      defaults: {
        cpuCores: 2,
        memoryMb: 4096,
        image: "ubuntu:24.04",
        allowDomains: ["pypi.org"],
        tags: ["team-a"],
      },
    };
    await call(
      t,
      "create",
      { options: { cpuCores: 4, memoryMb: 8192 } },
      config,
    );
    const forked = await call(t, "fork", { from: "main", to: "fork" }, config);
    const restore = fake.creates.at(-1)!;
    expect(restore).toMatchObject({
      snapshotId: "snap-1",
      cpuCores: 4,
      memoryMb: 8192,
      allowDomains: ["pypi.org"],
    });
    expect(restore.tags).toContain("team-a");
    expect(restore).not.toHaveProperty("image");
    expect(forked.remote).toMatchObject({ cpuCores: 4, memoryMb: 8192 });
  });
});

describe("errors", () => {
  test("generic SDK errors get specific codes", () => {
    const code = (err: Error) => describeError(err).code;
    expect(
      code(sdkError("SandboxError", "[invalid_argument] validation error")),
    ).toBe("invalid_argument");
    expect(code(sdkError("SandboxError", "[unavailable] retry shortly"))).toBe(
      "unavailable",
    );
    expect(
      code(
        sdkError(
          "SandboxError",
          "[unknown] session entered terminal state: TERMINATING",
        ),
      ),
    ).toBe("terminated");
    expect(code(new Error("session entered terminal state: TERMINATED"))).toBe(
      "terminated",
    );
    expect(code(sdkError("SnapshotNotFoundError"))).toBe("snapshot_not_found");
    expect(code(new Error("boom"))).toBe("internal");
  });

  test("spawn_failed says why when the guest prints nothing", async () => {
    const t = initConvexTest();
    await t.action(api.create, alice);
    fake.onExec = () => ({ ...reply(""), exitCode: 1 });
    expect(
      await convexErrorData(call(t, "spawn", { command: "true" })),
    ).toMatchObject({
      code: "spawn_failed",
      message: "spawn exited with 1 (exit)",
    });
  });

  test("a session one read can't find isn't marked terminated", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    fake.lagging.add(sessionId!);
    expect((await t.action(api.refresh, alice))?.phase).toBe("ready");
  });
});
