import { v } from "convex/values";
import { internalQuery } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { requireE2E } from "./e2eGate.js";

export const get = internalQuery({
  args: { ownerId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    requireE2E();
    return await ctx.runQuery(components.tenki.sandboxes.get, args);
  },
});
