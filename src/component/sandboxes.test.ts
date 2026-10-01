import { describe, expect, test } from "vitest";
import { api } from "./_generated/api.js";
import { initConvexTest } from "./setup.test.js";

const alice = { ownerId: "user_alice", key: "main" };
const remote = {
  state: "RUNNING",
  cpuCores: 2,
  memoryMb: 4096,
  diskSizeGb: 20,
  sticky: false,
};
const LEASE = 60_000;

describe("claim", () => {
  test("first caller takes the lease; others see the holder", async () => {
    const t = initConvexTest();
    const first = await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "a",
      leaseMs: LEASE,
    });
    expect(first.claimed).toBe(true);
    expect(first.sandbox.phase).toBe("provisioning");
    const second = await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "b",
      leaseMs: LEASE,
    });
    expect(second.claimed).toBe(false);
    expect(second.sandbox.claim?.token).toBe("a");
  });

  test("an expired lease without a session can be taken over", async () => {
    const t = initConvexTest();
    await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "a",
      leaseMs: -1,
    });
    const takeover = await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "b",
      leaseMs: LEASE,
    });
    expect(takeover.claimed).toBe(true);
    expect(takeover.sandbox.claim?.token).toBe("b");
  });

  test("a ready sandbox is never reclaimed", async () => {
    const t = initConvexTest();
    await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "a",
      leaseMs: LEASE,
    });
    await t.mutation(api.sandboxes.complete, {
      ...alice,
      token: "a",
      sessionId: "s1",
      phase: "ready",
      remote,
    });
    const again = await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "b",
      leaseMs: -1,
    });
    expect(again.claimed).toBe(false);
    expect(again.sandbox.sessionId).toBe("s1");
  });

  test("terminated and failed sandboxes are reclaimed with a clean slate", async () => {
    const t = initConvexTest();
    await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "a",
      leaseMs: LEASE,
    });
    await t.mutation(api.sandboxes.complete, {
      ...alice,
      token: "a",
      sessionId: "s1",
      phase: "ready",
      remote,
    });
    await t.mutation(api.sandboxes.sync, {
      ...alice,
      sessionId: "s1",
      phase: "terminated",
    });
    const reclaimed = await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "b",
      leaseMs: LEASE,
    });
    expect(reclaimed.claimed).toBe(true);
    expect(reclaimed.sandbox.sessionId).toBeUndefined();
    expect(reclaimed.sandbox.remote).toBeUndefined();

    await t.mutation(api.sandboxes.fail, {
      ...alice,
      token: "b",
      code: "quota_exceeded",
      message: "no",
    });
    const afterFailure = await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "c",
      leaseMs: LEASE,
    });
    expect(afterFailure.claimed).toBe(true);
    expect(afterFailure.sandbox.lastError).toBeUndefined();
  });

  test("rejects empty identities", async () => {
    const t = initConvexTest();
    await expect(
      t.mutation(api.sandboxes.claim, {
        ownerId: " ",
        key: "k",
        token: "a",
        leaseMs: 1,
      }),
    ).rejects.toThrow(/ownerId/);
    await expect(
      t.mutation(api.sandboxes.claim, {
        ownerId: "o",
        key: "",
        token: "a",
        leaseMs: 1,
      }),
    ).rejects.toThrow(/key/);
  });
});

describe("complete and fail", () => {
  test("only the lease holder can complete", async () => {
    const t = initConvexTest();
    await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "a",
      leaseMs: -1,
    });
    await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "b",
      leaseMs: LEASE,
    });
    const stale = await t.mutation(api.sandboxes.complete, {
      ...alice,
      token: "a",
      sessionId: "s1",
      phase: "ready",
      remote,
    });
    expect(stale.accepted).toBe(false);
    const current = await t.mutation(api.sandboxes.complete, {
      ...alice,
      token: "b",
      sessionId: "s2",
      phase: "ready",
      remote,
    });
    expect(current.accepted).toBe(true);
    expect(current.sandbox).toMatchObject({
      phase: "ready",
      sessionId: "s2",
      remote,
    });
    expect(current.sandbox?.claim).toBeUndefined();
  });

  test("a stale holder cannot overwrite with a failure", async () => {
    const t = initConvexTest();
    await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "a",
      leaseMs: LEASE,
    });
    await t.mutation(api.sandboxes.fail, {
      ...alice,
      token: "zzz",
      code: "internal",
      message: "x",
    });
    expect((await t.query(api.sandboxes.get, alice))?.phase).toBe(
      "provisioning",
    );
  });
});

describe("sync", () => {
  test("ignores updates for a session the row no longer points at", async () => {
    const t = initConvexTest();
    await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "a",
      leaseMs: LEASE,
    });
    await t.mutation(api.sandboxes.complete, {
      ...alice,
      token: "a",
      sessionId: "s1",
      phase: "ready",
      remote,
    });
    const ignored = await t.mutation(api.sandboxes.sync, {
      ...alice,
      sessionId: "old",
      phase: "terminated",
    });
    expect(ignored?.phase).toBe("ready");
    const applied = await t.mutation(api.sandboxes.sync, {
      ...alice,
      sessionId: "s1",
      phase: "paused",
      remote: { ...remote, state: "PAUSED" },
    });
    expect(applied).toMatchObject({
      phase: "paused",
      remote: { state: "PAUSED" },
    });
  });
});

describe("list", () => {
  test("is scoped to the owner", async () => {
    const t = initConvexTest();
    await t.mutation(api.sandboxes.claim, {
      ...alice,
      token: "a",
      leaseMs: LEASE,
    });
    await t.mutation(api.sandboxes.claim, {
      ownerId: "user_alice",
      key: "second",
      token: "b",
      leaseMs: LEASE,
    });
    await t.mutation(api.sandboxes.claim, {
      ownerId: "user_bob",
      key: "main",
      token: "c",
      leaseMs: LEASE,
    });
    expect(
      await t.query(api.sandboxes.list, { ownerId: "user_alice" }),
    ).toHaveLength(2);
    expect(
      await t.query(api.sandboxes.get, { ownerId: "user_bob", key: "second" }),
    ).toBeNull();
  });
});
