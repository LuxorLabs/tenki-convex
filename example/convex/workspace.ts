import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { components } from "./_generated/api.js";

// The example takes ownerId as an argument so scripts can drive it; a real app
// must derive it from ctx.auth.getUserIdentity().
export const get = query({
  args: { ownerId: v.string(), key: v.string() },
  handler: async (ctx, args) =>
    await ctx.runQuery(components.tenki.sandboxes.get, args),
});

export const list = query({
  args: { ownerId: v.string() },
  handler: async (ctx, args) =>
    await ctx.runQuery(components.tenki.sandboxes.list, args),
});
