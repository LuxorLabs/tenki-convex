import {
  TenkiSandbox,
  type CreateOptions,
  type ListOptions,
  type Session,
} from "@tenkicloud/sandbox";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import { ConvexError } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import {
  adoptionTag,
  canonical,
  describeError,
  isGone,
  isLive,
  phaseFromState,
  summarize,
  toArgv,
  truncateUtf8,
} from "./internal.js";

export type { Phase, RemoteSummary } from "./internal.js";

export type SandboxSession = Pick<
  Session,
  | "id"
  | "state"
  | "timeoutAt"
  | "cpuCores"
  | "memoryMb"
  | "diskSizeGb"
  | "sticky"
  | "exec"
  | "close"
  | "waitReady"
>;

/** The `@tenkicloud/sandbox` calls this package makes; inject a fake in tests. */
export interface SandboxClient {
  create(options: CreateOptions): Promise<SandboxSession>;
  get(sessionId: string): Promise<SandboxSession>;
  list(options: ListOptions): Promise<SandboxSession[]>;
}

export interface TenkiOptions {
  /** Defaults to the `TENKI_API_KEY` environment variable. */
  apiKey?: string;
  /** Defaults to `TENKI_API_URL`, then https://api.tenki.cloud. */
  baseUrl?: string;
  /**
   * Scopes sandbox identities so deployments sharing a Tenki workspace never
   * adopt each other's sandboxes. Defaults to the deployment's `CONVEX_CLOUD_URL`.
   */
  namespace?: string;
  /** Applied to every `create` call; per-call options win. */
  defaults?: CreateSandboxOptions;
  client?: SandboxClient;
}

export type CreateSandboxOptions = Omit<
  CreateOptions,
  "workspaceId" | "waitReady" | "tags" | "metadata"
> & {
  tags?: string[];
  metadata?: Record<string, string>;
};

export interface Identity {
  ownerId: string;
  key: string;
}

export interface ExecOptions {
  /** A string runs under `bash -lc`; an array runs as argv with no shell. */
  command: string | string[];
  cwd?: string;
  env?: Record<string, string>;
  /** Capped at 9 minutes so the call finishes inside Convex's action limit. */
  timeoutMs?: number;
  /** Per stream; output beyond it is dropped and flagged. Defaults to 1 MiB. */
  maxOutputBytes?: number;
}

export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  timedOut: boolean;
  reason?: string;
  durationMs: number;
}

export const MAX_EXEC_TIMEOUT_MS = 9 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20;
const CREATE_LEASE_MS = 5 * 60_000;
const WAIT_FOR_PEER_MS = 3 * 60_000;
const WAIT_POLL_MS = 1_000;
const SESSION_CACHE_LIMIT = 64;

// Action instances are reused while warm; a cached handle skips ~800ms of data-plane setup.
const sessionCache = new Map<string, SandboxSession>();

type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;

/**
 * Node-only: construct and call it from a `"use node"` file. Queries read the
 * component directly, e.g. `ctx.runQuery(components.tenki.sandboxes.get, …)`.
 */
export class Tenki {
  private sdk?: SandboxClient;

  constructor(
    public component: ComponentApi,
    private options: TenkiOptions = {},
  ) {}

  async get(ctx: ActionCtx, args: Identity) {
    return await ctx.runQuery(this.component.sandboxes.get, {
      ownerId: args.ownerId,
      key: args.key,
    });
  }

  async list(ctx: ActionCtx, args: { ownerId: string; limit?: number }) {
    return await ctx.runQuery(this.component.sandboxes.list, {
      ownerId: args.ownerId,
      limit: args.limit,
    });
  }

  /**
   * Returns the sandbox for (ownerId, key), creating it if needed. Safe to
   * retry and to call concurrently: one Tenki session exists per identity.
   */
  async create(
    ctx: ActionCtx,
    args: Identity & { options?: CreateSandboxOptions },
  ) {
    const identity = { ownerId: args.ownerId, key: args.key };
    const token = crypto.randomUUID();
    const { claimed, sandbox } = await ctx.runMutation(
      this.component.sandboxes.claim,
      {
        ...identity,
        token,
        leaseMs: CREATE_LEASE_MS,
      },
    );
    if (!claimed) {
      return sandbox.phase === "provisioning"
        ? await this.waitForPeer(ctx, identity)
        : sandbox;
    }

    try {
      const sdk = this.client();
      const tag = await this.tag(identity);
      let session = canonical((await sdk.list({ tags: [tag] })).filter(isLive));
      if (!session) {
        const options = { ...this.options.defaults, ...args.options };
        const created = await sdk.create({
          ...options,
          tags: [
            tag,
            ...(this.options.defaults?.tags ?? []),
            ...(args.options?.tags ?? []),
          ],
          metadata: {
            ...this.options.defaults?.metadata,
            ...args.options?.metadata,
            convex_namespace: this.namespace(),
            convex_owner_id: identity.ownerId,
            convex_key: identity.key,
          },
          waitReady: true,
        });
        session = await this.settleRace(sdk, tag, created);
      }
      if (session.state === "CREATING") await session.waitReady();
      cacheSession(session);
      const result = await ctx.runMutation(this.component.sandboxes.complete, {
        ...identity,
        token,
        sessionId: session.id,
        phase: phaseFromState(session.state),
        remote: summarize(session),
      });
      if (result.accepted) return result.sandbox!;
      return await this.waitForPeer(ctx, identity);
    } catch (err) {
      await ctx.runMutation(this.component.sandboxes.fail, {
        ...identity,
        token,
        ...describeError(err),
      });
      throw toConvexError(err);
    }
  }

  /** Re-reads the session from Tenki and updates the row. */
  async refresh(ctx: ActionCtx, args: Identity) {
    const identity = { ownerId: args.ownerId, key: args.key };
    const sandbox = await this.get(ctx, identity);
    if (!sandbox?.sessionId) return sandbox;
    const sessionId = sandbox.sessionId;
    try {
      const session = await this.client().get(sessionId);
      cacheSession(session);
      return await ctx.runMutation(this.component.sandboxes.sync, {
        ...identity,
        sessionId,
        phase: phaseFromState(session.state),
        remote: summarize(session),
      });
    } catch (err) {
      if (!isGone(err)) throw toConvexError(err);
      sessionCache.delete(sessionId);
      return await ctx.runMutation(this.component.sandboxes.sync, {
        ...identity,
        sessionId,
        phase: "terminated",
      });
    }
  }

  async exec(
    ctx: ActionCtx,
    args: Identity & ExecOptions,
  ): Promise<ExecResult> {
    const identity = { ownerId: args.ownerId, key: args.key };
    const sandbox = await this.get(ctx, identity);
    if (!sandbox?.sessionId) {
      throw new ConvexError({
        code: "not_found",
        message: `no sandbox for key "${args.key}"`,
      });
    }
    if (sandbox.phase !== "ready") {
      throw new ConvexError({
        code: "not_ready",
        message: `sandbox is ${sandbox.phase}`,
        phase: sandbox.phase,
      });
    }
    const sessionId = sandbox.sessionId;
    const timeoutMs = Math.min(
      args.timeoutMs ?? MAX_EXEC_TIMEOUT_MS,
      MAX_EXEC_TIMEOUT_MS,
    );
    const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    try {
      const session = await this.session(sessionId);
      const r = await session.exec(toArgv(args.command), {
        cwd: args.cwd,
        env: args.env,
        timeoutMs,
      });
      const stdout = truncateUtf8(r.stdout, maxOutputBytes);
      const stderr = truncateUtf8(r.stderr, maxOutputBytes);
      return {
        exitCode: r.exitCode,
        stdout: stdout.text,
        stderr: stderr.text,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        timedOut: r.reason === "timeout" || r.reason === "grace_timeout",
        ...(r.reason ? { reason: r.reason } : {}),
        durationMs: r.durationMs,
      };
    } catch (err) {
      sessionCache.delete(sessionId);
      if (isGone(err)) {
        await ctx.runMutation(this.component.sandboxes.sync, {
          ...identity,
          sessionId,
          phase: "terminated",
        });
      }
      throw toConvexError(err);
    }
  }

  /** Terminates the sandbox, including any orphan a crashed `create` left behind. */
  async destroy(ctx: ActionCtx, args: Identity) {
    const identity = { ownerId: args.ownerId, key: args.key };
    const sdk = this.client();
    const sandbox = await this.get(ctx, identity);
    const tagged = (
      await sdk.list({ tags: [await this.tag(identity)] })
    ).filter(isLive);
    const ids = new Set(tagged.map((s) => s.id));
    if (sandbox?.sessionId) ids.add(sandbox.sessionId);
    for (const id of ids) {
      sessionCache.delete(id);
      try {
        const session = tagged.find((s) => s.id === id) ?? (await sdk.get(id));
        await session.close();
      } catch (err) {
        if (!isGone(err)) throw toConvexError(err);
      }
    }
    if (!sandbox?.sessionId) return sandbox;
    return await ctx.runMutation(this.component.sandboxes.sync, {
      ...identity,
      sessionId: sandbox.sessionId,
      phase: "terminated",
    });
  }

  private client(): SandboxClient {
    if (this.options.client) return this.options.client;
    if (!this.sdk) {
      const apiKey = this.options.apiKey ?? process.env.TENKI_API_KEY;
      if (!apiKey) {
        throw new ConvexError({
          code: "unauthenticated",
          message:
            "TENKI_API_KEY is not set. Run: npx convex env set TENKI_API_KEY tk_...",
        });
      }
      this.sdk = new TenkiSandbox({
        apiKey,
        baseUrl: this.options.baseUrl ?? process.env.TENKI_API_URL,
      });
    }
    return this.sdk;
  }

  private namespace(): string {
    return this.options.namespace ?? process.env.CONVEX_CLOUD_URL ?? "default";
  }

  private async tag(identity: Identity): Promise<string> {
    return await adoptionTag(this.namespace(), identity.ownerId, identity.key);
  }

  private async session(sessionId: string): Promise<SandboxSession> {
    const cached = sessionCache.get(sessionId);
    if (cached) return cached;
    const session = await this.client().get(sessionId);
    cacheSession(session);
    return session;
  }

  /** Concurrent creators converge on the oldest live session; the rest are terminated. */
  private async settleRace(
    sdk: SandboxClient,
    tag: string,
    created: SandboxSession,
  ): Promise<SandboxSession> {
    const live = (await sdk.list({ tags: [tag] })).filter(isLive);
    const winner = canonical([...live, created])!;
    if (winner.id !== created.id) {
      await created.close().catch(() => {});
    }
    return winner;
  }

  private async waitForPeer(ctx: ActionCtx, identity: Identity) {
    const deadline = Date.now() + WAIT_FOR_PEER_MS;
    for (;;) {
      const sandbox = await this.get(ctx, identity);
      if (!sandbox || sandbox.phase !== "provisioning" || Date.now() > deadline)
        return sandbox!;
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
    }
  }
}

function cacheSession(session: SandboxSession) {
  sessionCache.delete(session.id);
  sessionCache.set(session.id, session);
  if (sessionCache.size > SESSION_CACHE_LIMIT) {
    sessionCache.delete(sessionCache.keys().next().value!);
  }
}

function toConvexError(err: unknown): Error {
  if (err instanceof ConvexError) return err;
  return new ConvexError(describeError(err));
}
