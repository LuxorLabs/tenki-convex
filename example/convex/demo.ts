"use node";
import { getAuthUserId } from "@convex-dev/auth/server";
import { ConvexError, v } from "convex/values";
import { Tenki } from "@tenkicloud/convex";
import { action, type ActionCtx } from "./_generated/server.js";
import { components } from "./_generated/api.js";

// Guard rails for a public demo: short-lived, small, egress limited to package
// registries, and a cap on active sandboxes across all visitors (forks included).
const DEMO_LIFETIME_MS = 10 * 60_000;
const MAX_ACTIVE_SANDBOXES = Number(
  process.env.DEMO_MAX_ACTIVE_SANDBOXES ?? 10,
);
const MAX_COMMAND_CHARS = 2_000;
const EXEC_TIMEOUT_MS = 60_000;
const PREVIEW_PORT = 8000;

const tenki = new Tenki(components.tenki, {
  defaults: {
    cpuCores: 2,
    memoryMb: 2048,
    maxDurationMs: DEMO_LIFETIME_MS,
    allowDomains: ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org"],
    tags: ["convex-demo"],
  },
  maxActiveSandboxes: MAX_ACTIVE_SANDBOXES,
});

const sandboxKey = v.union(v.literal("main"), v.literal("fork"));
type Identity = { ownerId: string; key: "main" | "fork" };

// Tenki pauses a sandbox at its deadline, and resuming it starts a new lifetime,
// so the demo never resumes one older than DEMO_LIFETIME_MS.
async function outlived(ctx: ActionCtx, identity: Identity) {
  const sandbox = await tenki.get(ctx, identity);
  if (!sandbox?.sessionId || sandbox.phase === "terminated") return false;
  // Session ids are UUIDv7: the first 48 bits are the creation time in ms.
  const createdAt = parseInt(
    sandbox.sessionId.replaceAll("-", "").slice(0, 12),
    16,
  );
  return Date.now() - createdAt > DEMO_LIFETIME_MS;
}

async function ownerId(ctx: ActionCtx): Promise<string> {
  const userId = await getAuthUserId(ctx);
  if (!userId) {
    throw new ConvexError({
      code: "unauthenticated",
      message: "Sign in first",
    });
  }
  return userId;
}

export const create = action({
  args: {},
  handler: async (ctx) => {
    const identity: Identity = { ownerId: await ownerId(ctx), key: "main" };
    if (await outlived(ctx, identity)) await tenki.destroy(ctx, identity);
    return await tenki.create(ctx, identity);
  },
});

export const run = action({
  args: { key: sandboxKey, command: v.string() },
  handler: async (ctx, args) => {
    if (args.command.length > MAX_COMMAND_CHARS) {
      throw new ConvexError({
        code: "invalid_argument",
        message: "Command is too long",
      });
    }
    return await tenki.exec(ctx, {
      ownerId: await ownerId(ctx),
      key: args.key,
      command: args.command,
      timeoutMs: EXEC_TIMEOUT_MS,
      maxOutputBytes: 64 << 10,
    });
  },
});

/** Starts a web server in the background and returns its public preview URL. */
export const startWebServer = action({
  args: { key: sandboxKey },
  handler: async (ctx, args) => {
    const identity = { ownerId: await ownerId(ctx), key: args.key };
    const page = `<!doctype html><title>Hello from Tenki</title>
<body style="font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0">
<div><h1>Served from a Tenki sandbox</h1><p>Started by a Convex action at ${new Date().toISOString()}.</p></div>`;
    await tenki.writeFile(ctx, {
      ...identity,
      path: "/home/tenki/site/index.html",
      data: page,
    });
    await tenki.spawn(ctx, {
      ...identity,
      command: `cd ~/site && exec python3 -m http.server ${PREVIEW_PORT}`,
    });
    return await tenki.exposePort(ctx, {
      ...identity,
      port: PREVIEW_PORT,
      ttlMs: DEMO_LIFETIME_MS,
    });
  },
});

export const pause = action({
  args: { key: sandboxKey },
  handler: async (ctx, args) =>
    await tenki.pause(ctx, {
      ownerId: await ownerId(ctx),
      key: args.key,
      wait: false,
    }),
});

export const resume = action({
  args: { key: sandboxKey },
  handler: async (ctx, args) => {
    const identity: Identity = { ownerId: await ownerId(ctx), key: args.key };
    if (await outlived(ctx, identity)) {
      throw new ConvexError({
        code: "expired",
        message: "This sandbox reached its 10-minute lifetime; destroy it",
      });
    }
    return await tenki.resume(ctx, identity);
  },
});

export const refresh = action({
  args: { key: sandboxKey },
  handler: async (ctx, args) =>
    await tenki.refresh(ctx, { ownerId: await ownerId(ctx), key: args.key }),
});

export const fork = action({
  args: {},
  handler: async (ctx) =>
    await tenki.fork(ctx, {
      ownerId: await ownerId(ctx),
      from: "main",
      to: "fork",
    }),
});

export const destroy = action({
  args: { key: sandboxKey },
  handler: async (ctx, args) =>
    await tenki.destroy(ctx, { ownerId: await ownerId(ctx), key: args.key }),
});
