"use node";
import { v } from "convex/values";
import { Tenki } from "@tenkicloud/convex";
import { action, internalAction } from "./_generated/server.js";
import { components } from "./_generated/api.js";

const tenki = new Tenki(components.tenki, {
  defaults: { cpuCores: 2, memoryMb: 4096, maxDurationMs: 30 * 60_000 },
});

// The example takes ownerId as an argument so scripts can drive it; a real app
// must derive it from ctx.auth.getUserIdentity().
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

export const spawn = action({
  args: { ...identity, command: v.string() },
  handler: async (ctx, args) => await tenki.spawn(ctx, args),
});

export const processStatus = action({
  args: { ...identity, processId: v.string() },
  handler: async (ctx, args) => await tenki.processStatus(ctx, args),
});

export const kill = action({
  args: { ...identity, processId: v.string() },
  handler: async (ctx, args) => await tenki.kill(ctx, args),
});

export const readText = action({
  args: { ...identity, path: v.string() },
  handler: async (ctx, args) => await tenki.readFile(ctx, args),
});

export const readBytes = action({
  args: { ...identity, path: v.string() },
  handler: async (ctx, args) =>
    await tenki.readFile(ctx, { ...args, encoding: "bytes" }),
});

export const writeFile = action({
  args: { ...identity, path: v.string(), data: v.union(v.string(), v.bytes()) },
  handler: async (ctx, args) => await tenki.writeFile(ctx, args),
});

export const exposePort = action({
  args: { ...identity, port: v.number() },
  handler: async (ctx, args) => await tenki.exposePort(ctx, args),
});

export const extend = action({
  args: { ...identity, additionalMs: v.number() },
  handler: async (ctx, args) => await tenki.extend(ctx, args),
});

export const pause = action({
  args: identity,
  handler: async (ctx, args) => await tenki.pause(ctx, args),
});

export const resume = action({
  args: identity,
  handler: async (ctx, args) => await tenki.resume(ctx, args),
});

export const fork = action({
  args: { ownerId: v.string(), from: v.string(), to: v.string() },
  handler: async (ctx, args) => await tenki.fork(ctx, args),
});

export const refresh = action({
  args: identity,
  handler: async (ctx, args) => await tenki.refresh(ctx, args),
});

export const destroy = action({
  args: identity,
  handler: async (ctx, args) => await tenki.destroy(ctx, args),
});

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => await tenki.reconcile(ctx),
});
