import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server.js";
import { components } from "./_generated/api.js";

/** The signed-in visitor's sandboxes, live: the UI re-renders on every phase change. */
export const mine = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getAuthUserId(ctx);
    if (!ownerId) return null;
    const rows = await ctx.runQuery(components.tenki.sandboxes.list, {
      ownerId,
    });
    return {
      main: rows.find((r) => r.key === "main") ?? null,
      fork: rows.find((r) => r.key === "fork") ?? null,
    };
  },
});
