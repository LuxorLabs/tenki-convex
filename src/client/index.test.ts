// @vitest-environment node
import { anyApi, actionGeneric, type ApiFromModules } from "convex/server";
import { ConvexError, v } from "convex/values";
import { beforeEach, describe, expect, test } from "vitest";
import { MAX_EXEC_TIMEOUT_MS, Tenki } from "./index.js";
import { adoptionTag } from "./internal.js";
import { FakeSdk, sdkError } from "./fake.test.js";
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

const api = (
  anyApi as unknown as ApiFromModules<{
    "index.test": {
      create: typeof create;
      exec: typeof exec;
      refresh: typeof refresh;
      destroy: typeof destroy;
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
    expect(fake.sessions.get(sessionId!)!.argv[0]).toEqual([
      "bash",
      "-lc",
      "echo ok && pwd",
    ]);
  });

  test("passes argv through and caps the timeout", async () => {
    const t = initConvexTest();
    const { sessionId } = await t.action(api.create, alice);
    await t.action(api.exec, {
      ...alice,
      command: ["ls", "-la"],
      timeoutMs: 60 * 60_000,
    });
    expect(fake.sessions.get(sessionId!)!.argv[0]).toEqual(["ls", "-la"]);
    expect(fake.execOptions[0]).toMatchObject({
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
