"use node";
import { v } from "convex/values";
import { Tenki } from "@tenkicloud/convex";
import { internalAction } from "./_generated/server.js";
import { components } from "./_generated/api.js";
import { requireE2E } from "./e2eGate.js";

const tenki = new Tenki(components.tenki, {
  defaults: { cpuCores: 2, memoryMb: 4096, maxDurationMs: 30 * 60_000 },
});

// Drives scripts/e2e.mjs with an admin key. ownerId comes from the caller, so
// every function is internal and also gated to test deployments; see demo.ts
// for the auth-derived version.
const identity = { ownerId: v.string(), key: v.string() };

export const create = internalAction({
  args: { ...identity, tags: v.optional(v.array(v.string())) },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.create(ctx, {
      ownerId: args.ownerId,
      key: args.key,
      options: { tags: args.tags },
    });
  },
});

export const exec = internalAction({
  args: {
    ...identity,
    command: v.union(v.string(), v.array(v.string())),
    timeoutMs: v.optional(v.number()),
    maxOutputBytes: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.exec(ctx, args);
  },
});

export const spawn = internalAction({
  args: { ...identity, command: v.string() },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.spawn(ctx, args);
  },
});

export const processStatus = internalAction({
  args: { ...identity, processId: v.string() },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.processStatus(ctx, args);
  },
});

export const kill = internalAction({
  args: { ...identity, processId: v.string() },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.kill(ctx, args);
  },
});

export const readText = internalAction({
  args: { ...identity, path: v.string() },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.readFile(ctx, args);
  },
});

export const readBytes = internalAction({
  args: { ...identity, path: v.string() },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.readFile(ctx, { ...args, encoding: "bytes" });
  },
});

export const writeFile = internalAction({
  args: { ...identity, path: v.string(), data: v.union(v.string(), v.bytes()) },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.writeFile(ctx, args);
  },
});

export const exposePort = internalAction({
  args: { ...identity, port: v.number() },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.exposePort(ctx, args);
  },
});

export const extend = internalAction({
  args: { ...identity, additionalMs: v.number() },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.extend(ctx, args);
  },
});

export const pause = internalAction({
  args: identity,
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.pause(ctx, args);
  },
});

export const resume = internalAction({
  args: identity,
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.resume(ctx, args);
  },
});

export const fork = internalAction({
  args: {
    ownerId: v.string(),
    from: v.string(),
    to: v.string(),
    name: v.optional(v.string()),
    tags: v.optional(v.array(v.string())),
  },
  handler: async (ctx, { tags, ...args }) => {
    requireE2E();
    return await tenki.fork(ctx, { ...args, options: { tags } });
  },
});

export const refresh = internalAction({
  args: identity,
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.refresh(ctx, args);
  },
});

export const destroy = internalAction({
  args: identity,
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.destroy(ctx, args);
  },
});

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => {
    requireE2E();
    return await tenki.reconcile(ctx);
  },
});

export const createWithBadKey = internalAction({
  args: identity,
  handler: async (ctx, args) => {
    requireE2E();
    return await new Tenki(components.tenki, {
      apiKey: "tk_" + "0".repeat(40),
    }).create(ctx, args);
  },
});

export const createShortLived = internalAction({
  args: { ...identity, maxDurationMs: v.number(), tags: v.array(v.string()) },
  handler: async (ctx, args) => {
    requireE2E();
    return await tenki.create(ctx, {
      ownerId: args.ownerId,
      key: args.key,
      options: { maxDurationMs: args.maxDurationMs, tags: args.tags },
    });
  },
});
