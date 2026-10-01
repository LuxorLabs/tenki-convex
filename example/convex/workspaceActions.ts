"use node";
import { v } from "convex/values";
import { Tenki } from "@tenkicloud/convex";
import { action } from "./_generated/server.js";
import { components } from "./_generated/api.js";

const tenki = new Tenki(components.tenki, {
  defaults: { cpuCores: 2, memoryMb: 4096, maxDurationMs: 30 * 60_000 },
});

const identity = { ownerId: v.string(), key: v.string() };

export const create = action({
  args: { ...identity, tags: v.optional(v.array(v.string())) },
  handler: async (ctx, args) =>
    await tenki.create(ctx, {
      ownerId: args.ownerId,
      key: args.key,
      options: { tags: args.tags },
    }),
});

export const exec = action({
  args: {
    ...identity,
    command: v.union(v.string(), v.array(v.string())),
    timeoutMs: v.optional(v.number()),
  },
  handler: async (ctx, args) => await tenki.exec(ctx, args),
});

export const refresh = action({
  args: identity,
  handler: async (ctx, args) => await tenki.refresh(ctx, args),
});

export const destroy = action({
  args: identity,
  handler: async (ctx, args) => await tenki.destroy(ctx, args),
});
