import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import schema, {
  phaseValidator,
  previewValidator,
  remoteValidator,
} from "./schema.js";

export const sandboxValidator = schema.tables.sandboxes.validator.extend({
  _id: v.id("sandboxes"),
  _creationTime: v.number(),
});

const identity = { ownerId: v.string(), key: v.string() };
// No lease runs longer than this, so a destroyed row with a live lease was updated within it.
const MAX_LEASE_MS = 60 * 60_000;

function requireIdentity(args: { ownerId: string; key: string }) {
  if (args.ownerId.trim().length === 0)
    throw new Error("ownerId must not be empty");
  if (args.key.trim().length === 0) throw new Error("key must not be empty");
}

async function find(ctx: QueryCtx, ownerId: string, key: string) {
  return await ctx.db
    .query("sandboxes")
    .withIndex("by_owner_key", (q) => q.eq("ownerId", ownerId).eq("key", key))
    .unique();
}

export const get = query({
  args: identity,
  returns: v.union(sandboxValidator, v.null()),
  handler: async (ctx, args) => await find(ctx, args.ownerId, args.key),
});

export const list = query({
  args: { ownerId: v.string(), limit: v.optional(v.number()) },
  returns: v.array(sandboxValidator),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 100), 500));
    return await ctx.db
      .query("sandboxes")
      .withIndex("by_owner_key", (q) => q.eq("ownerId", args.ownerId))
      .take(limit);
  },
});

/**
 * Takes the creation lease for (ownerId, key), or reports who holds it.
 * A terminated or failed sandbox is reclaimed so the key can be reused.
 */
export const claim = mutation({
  args: {
    ...identity,
    token: v.string(),
    leaseMs: v.number(),
    // Refuse to start a new sandbox once this many are active across all owners.
    maxActive: v.optional(v.number()),
  },
  returns: v.object({
    claimed: v.boolean(),
    full: v.optional(v.boolean()),
    sandbox: v.union(sandboxValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    requireIdentity(args);
    const now = Date.now();
    const lease = {
      token: args.token,
      expiresAt: now + Math.min(args.leaseMs, MAX_LEASE_MS),
    };
    const existing = await find(ctx, args.ownerId, args.key);
    const atCapacity = async () =>
      args.maxActive !== undefined &&
      (await countActive(ctx, args.maxActive, now)) >= args.maxActive;
    if (!existing) {
      if (await atCapacity())
        return { claimed: false, full: true, sandbox: null };
      const id = await ctx.db.insert("sandboxes", {
        ownerId: args.ownerId,
        key: args.key,
        phase: "provisioning",
        claim: lease,
        updatedAt: now,
      });
      return { claimed: true, sandbox: (await ctx.db.get("sandboxes", id))! };
    }
    const reclaimable =
      (existing.phase === "terminated" &&
        !(existing.claim && existing.claim.expiresAt >= now)) ||
      existing.phase === "error" ||
      (existing.phase === "provisioning" &&
        !existing.sessionId &&
        (!existing.claim || existing.claim.expiresAt < now));
    if (!reclaimable) return { claimed: false, sandbox: existing };
    if (await atCapacity())
      return { claimed: false, full: true, sandbox: existing };
    await ctx.db.patch("sandboxes", existing._id, {
      phase: "provisioning",
      claim: lease,
      sessionId: undefined,
      remote: undefined,
      previews: undefined,
      lastError: undefined,
      updatedAt: now,
    });
    return {
      claimed: true,
      sandbox: (await ctx.db.get("sandboxes", existing._id))!,
    };
  },
});

/** Records the session the lease holder created or adopted. Rejected if the lease moved on. */
export const complete = mutation({
  args: {
    ...identity,
    token: v.string(),
    sessionId: v.string(),
    phase: phaseValidator,
    remote: remoteValidator,
  },
  returns: v.object({
    accepted: v.boolean(),
    sandbox: v.union(sandboxValidator, v.null()),
  }),
  handler: async (ctx, args) => {
    const existing = await find(ctx, args.ownerId, args.key);
    if (!existing || existing.claim?.token !== args.token) {
      return { accepted: false, sandbox: existing };
    }
    // Destroyed while it was being created. The lease stays until the create has
    // closed its session and called `fail`, so no other create can adopt it first.
    if (existing.phase === "terminated") {
      return { accepted: false, sandbox: existing };
    }
    await ctx.db.patch("sandboxes", existing._id, {
      phase: args.phase,
      sessionId: args.sessionId,
      remote: args.remote,
      claim: undefined,
      lastError: undefined,
      updatedAt: Date.now(),
    });
    return {
      accepted: true,
      sandbox: (await ctx.db.get("sandboxes", existing._id))!,
    };
  },
});

export const fail = mutation({
  args: {
    ...identity,
    token: v.string(),
    code: v.string(),
    message: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await find(ctx, args.ownerId, args.key);
    if (!existing || existing.claim?.token !== args.token) return null;
    const now = Date.now();
    if (existing.phase === "terminated") {
      await ctx.db.patch("sandboxes", existing._id, {
        claim: undefined,
        updatedAt: now,
      });
      return null;
    }
    await ctx.db.patch("sandboxes", existing._id, {
      phase: "error",
      claim: undefined,
      lastError: { code: args.code, message: args.message, at: now },
      updatedAt: now,
    });
    return null;
  },
});

/** Applies an observed remote state. Ignored unless the row still points at this session. */
export const sync = mutation({
  args: {
    ...identity,
    sessionId: v.string(),
    phase: phaseValidator,
    remote: v.optional(remoteValidator),
  },
  returns: v.union(sandboxValidator, v.null()),
  handler: async (ctx, args) => {
    const existing = await find(ctx, args.ownerId, args.key);
    if (!existing || existing.sessionId !== args.sessionId) return existing;
    await ctx.db.patch("sandboxes", existing._id, {
      phase: args.phase,
      ...(args.remote ? { remote: args.remote } : {}),
      ...(args.phase === "terminated" ? { previews: undefined } : {}),
      updatedAt: Date.now(),
    });
    return (await ctx.db.get("sandboxes", existing._id))!;
  },
});

/**
 * Marks the row resuming. Resuming a paused sandbox starts it again, so it's
 * refused once `maxActive` sandboxes are active, as in `claim`.
 */
export const beginResume = mutation({
  args: {
    ...identity,
    sessionId: v.string(),
    maxActive: v.optional(v.number()),
  },
  returns: v.object({ full: v.boolean() }),
  handler: async (ctx, args) => {
    const existing = await find(ctx, args.ownerId, args.key);
    if (!existing || existing.sessionId !== args.sessionId) {
      return { full: false };
    }
    const now = Date.now();
    if (
      existing.phase === "paused" &&
      args.maxActive !== undefined &&
      (await countActive(ctx, args.maxActive, now)) >= args.maxActive
    ) {
      return { full: true };
    }
    await ctx.db.patch("sandboxes", existing._id, {
      phase: "resuming",
      updatedAt: now,
    });
    return { full: false };
  },
});

/**
 * Marks the row terminated after `destroy` closed `closed`. A create still in
 * flight keeps its lease, so its slot stays counted and other creates wait for
 * it, but `complete` then rejects it. A row that points at a session `destroy`
 * never closed is returned unchanged.
 */
export const release = mutation({
  args: { ...identity, closed: v.array(v.string()) },
  returns: v.union(sandboxValidator, v.null()),
  handler: async (ctx, args) => {
    const existing = await find(ctx, args.ownerId, args.key);
    if (!existing) return null;
    if (existing.sessionId && !args.closed.includes(existing.sessionId)) {
      return existing;
    }
    const now = Date.now();
    const inFlight =
      !existing.sessionId &&
      existing.claim !== undefined &&
      existing.claim.expiresAt >= now;
    await ctx.db.patch("sandboxes", existing._id, {
      phase: "terminated",
      claim: inFlight ? existing.claim : undefined,
      previews: undefined,
      updatedAt: now,
    });
    return (await ctx.db.get("sandboxes", existing._id))!;
  },
});

/** Records a preview URL, replacing any earlier one for the same port. */
export const setPreview = mutation({
  args: { ...identity, sessionId: v.string(), preview: previewValidator },
  returns: v.union(sandboxValidator, v.null()),
  handler: async (ctx, args) => {
    const existing = await find(ctx, args.ownerId, args.key);
    if (!existing || existing.sessionId !== args.sessionId) return existing;
    const previews = (existing.previews ?? []).filter(
      (p) => p.port !== args.preview.port,
    );
    await ctx.db.patch("sandboxes", existing._id, {
      previews: [...previews, args.preview].sort((a, b) => a.port - b.port),
      updatedAt: Date.now(),
    });
    return (await ctx.db.get("sandboxes", existing._id))!;
  },
});

const LIVE_PHASES = [
  "ready",
  "pausing",
  "paused",
  "resuming",
  "provisioning",
] as const;
// Paused sandboxes hold no compute, matching Tenki's own active-session count.
const ACTIVE_PHASES = ["ready", "pausing", "resuming", "provisioning"] as const;

/** Counts active sandboxes, including creates in flight, up to `limit`. */
async function countActive(ctx: QueryCtx, limit: number, now: number) {
  // A create that destroy cancelled keeps its slot until it winds down.
  const cancelled = await ctx.db
    .query("sandboxes")
    .withIndex("by_phase_updated", (q) =>
      q.eq("phase", "terminated").gte("updatedAt", now - MAX_LEASE_MS),
    )
    // eslint-disable-next-line @convex-dev/no-filter-in-query
    .filter((q) => q.gte(q.field("claim.expiresAt"), now))
    .take(limit);
  let count = cancelled.length;
  if (count >= limit) return count;
  for (const phase of ACTIVE_PHASES) {
    const rows = await ctx.db
      .query("sandboxes")
      .withIndex("by_phase_updated", (q) => q.eq("phase", phase))
      // Bounded by the phase index; skips only abandoned claims.
      // eslint-disable-next-line @convex-dev/no-filter-in-query
      .filter((q) =>
        q.or(
          q.neq(q.field("sessionId"), undefined),
          q.gte(q.field("claim.expiresAt"), now),
        ),
      )
      .take(limit - count);
    count += rows.length;
    if (count >= limit) break;
  }
  return count;
}

/** Least recently updated live rows with a session, across all owners, for periodic reconciliation. */
export const stale = query({
  args: { limit: v.number() },
  returns: v.array(sandboxValidator),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(Math.floor(args.limit), 200));
    const perPhase = await Promise.all(
      LIVE_PHASES.map((phase) =>
        ctx.db
          .query("sandboxes")
          .withIndex("by_phase_updated", (q) => q.eq("phase", phase))
          // Bounded by the phase index; skips only creates that never got a session.
          // eslint-disable-next-line @convex-dev/no-filter-in-query
          .filter((q) => q.neq(q.field("sessionId"), undefined))
          .take(limit),
      ),
    );
    return perPhase
      .flat()
      .sort((a, b) => a.updatedAt - b.updatedAt)
      .slice(0, limit);
  },
});

/** Moves a row to the back of the reconcile queue without changing it. */
export const touch = mutation({
  args: { ...identity, sessionId: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await find(ctx, args.ownerId, args.key);
    if (existing?.sessionId === args.sessionId) {
      await ctx.db.patch("sandboxes", existing._id, { updatedAt: Date.now() });
    }
    return null;
  },
});

export const snapshotValidator = schema.tables.snapshots.validator.extend({
  _id: v.id("snapshots"),
  _creationTime: v.number(),
});

export const recordSnapshot = mutation({
  args: {
    ...identity,
    sessionId: v.string(),
    snapshotId: v.string(),
    name: v.optional(v.string()),
  },
  returns: snapshotValidator,
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("snapshots", args);
    return (await ctx.db.get("snapshots", id))!;
  },
});

export const listSnapshots = query({
  args: { ...identity, limit: v.optional(v.number()) },
  returns: v.array(snapshotValidator),
  handler: async (ctx, args) => {
    const limit = Math.max(1, Math.min(Math.floor(args.limit ?? 100), 500));
    return await ctx.db
      .query("snapshots")
      .withIndex("by_owner_key", (q) =>
        q.eq("ownerId", args.ownerId).eq("key", args.key),
      )
      .order("desc")
      .take(limit);
  },
});
