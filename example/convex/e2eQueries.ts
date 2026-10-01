import { v } from "convex/values";
import { query } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { requireE2E } from "./e2eGate.js";

export const get = query({
  args: { ownerId: v.string(), key: v.string() },
  handler: async (ctx, args) => {
    requireE2E();
    return await ctx.runQuery(components.tenki.sandboxes.get, args);
  },
});
