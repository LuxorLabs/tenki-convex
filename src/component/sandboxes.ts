import { v } from "convex/values";
import { mutation, query, type QueryCtx } from "./_generated/server.js";
import schema, { phaseValidator, remoteValidator } from "./schema.js";

export const sandboxValidator = schema.tables.sandboxes.validator.extend({
  _id: v.id("sandboxes"),
  _creationTime: v.number(),
});

const identity = { ownerId: v.string(), key: v.string() };

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
  args: { ...identity, token: v.string(), leaseMs: v.number() },
  returns: v.object({ claimed: v.boolean(), sandbox: sandboxValidator }),
  handler: async (ctx, args) => {
    requireIdentity(args);
    const now = Date.now();
    const lease = { token: args.token, expiresAt: now + args.leaseMs };
    const existing = await find(ctx, args.ownerId, args.key);
    if (!existing) {
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
      existing.phase === "terminated" ||
      existing.phase === "error" ||
      (existing.phase === "provisioning" &&
        !existing.sessionId &&
        (!existing.claim || existing.claim.expiresAt < now));
    if (!reclaimable) return { claimed: false, sandbox: existing };
    await ctx.db.patch("sandboxes", existing._id, {
      phase: "provisioning",
      claim: lease,
      sessionId: undefined,
      remote: undefined,
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
      updatedAt: Date.now(),
    });
    return (await ctx.db.get("sandboxes", existing._id))!;
  },
});
