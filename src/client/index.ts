import {
  TenkiSandbox,
  type CreateOptions,
  type CreateSnapshotOptions,
  type ListOptions,
  type Session,
  type Snapshot,
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
  KILL_SCRIPT,
  newProcessId,
  parseStatus,
  phaseFromState,
  requireProcessId,
  SPAWN_SCRIPT,
  STATUS_SCRIPT,
  summarize,
  toArgv,
  truncateUtf8,
  type Phase,
  type ProcessState,
} from "./internal.js";

export type { Phase, ProcessState, RemoteSummary } from "./internal.js";

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
  | "pause"
  | "pauseAsync"
  | "waitPaused"
  | "resume"
  | "waitResumed"
  | "extend"
  | "readFile"
  | "writeFile"
  | "exposePort"
>;

/** The `@tenkicloud/sandbox` calls this package makes; inject a fake in tests. */
export interface SandboxClient {
  create(options: CreateOptions): Promise<SandboxSession>;
  get(sessionId: string): Promise<SandboxSession>;
  list(options: ListOptions): Promise<SandboxSession[]>;
  createSnapshotAndWait(
    sessionId: string,
    options?: CreateSnapshotOptions,
  ): Promise<Pick<Snapshot, "id">>;
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

export interface ProcessStatus {
  state: ProcessState;
  exitCode?: number;
  signal?: string;
  /** The last `tailBytes` of combined stdout and stderr. */
  output: string;
  outputTruncated: boolean;
}

export type Signal = "TERM" | "KILL" | "INT" | "HUP";

export const MAX_EXEC_TIMEOUT_MS = 9 * 60_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1 << 20;
const DEFAULT_TAIL_BYTES = 64 << 10;
const CREATE_LEASE_MS = 5 * 60_000;
const WAIT_FOR_PEER_MS = 3 * 60_000;
const WAIT_POLL_MS = 1_000;
const RESUME_READY_MS = 60_000;
const SESSION_CACHE_LIMIT = 64;
const SIGNALS: readonly Signal[] = ["TERM", "KILL", "INT", "HUP"];

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
    const identity = pick(args);
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
    const identity = pick(args);
    const sandbox = await this.get(ctx, identity);
    if (!sandbox?.sessionId) return sandbox;
    return await this.syncFromRemote(ctx, identity, sandbox.sessionId);
  }

  async exec(
    ctx: ActionCtx,
    args: Identity & ExecOptions,
  ): Promise<ExecResult> {
    const timeoutMs = Math.min(
      args.timeoutMs ?? MAX_EXEC_TIMEOUT_MS,
      MAX_EXEC_TIMEOUT_MS,
    );
    const maxOutputBytes = args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    return await this.withSession(ctx, args, async (session) => {
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
    });
  }

  /**
   * Starts a command in the background and returns at once. It keeps running
   * after this action ends and across pause/resume; poll it with `processStatus`.
   */
  async spawn(
    ctx: ActionCtx,
    args: Identity & {
      command: string;
      cwd?: string;
      env?: Record<string, string>;
    },
  ): Promise<{ processId: string; pid: number }> {
    const processId = newProcessId();
    return await this.withSession(ctx, args, async (session) => {
      const r = await session.exec(["bash", "-c", SPAWN_SCRIPT], {
        cwd: args.cwd,
        env: {
          ...args.env,
          TENKI_CVX_ID: processId,
          TENKI_CVX_CMD: args.command,
        },
        timeoutMs: 30_000,
      });
      if (r.exitCode !== 0) {
        throw new ConvexError({
          code: "spawn_failed",
          message: new TextDecoder().decode(r.stderr).trim(),
        });
      }
      return {
        processId,
        pid: Number(new TextDecoder().decode(r.stdout).trim()),
      };
    });
  }

  async processStatus(
    ctx: ActionCtx,
    args: Identity & { processId: string; tailBytes?: number },
  ): Promise<ProcessStatus> {
    requireProcessId(args.processId);
    const tailBytes = Math.max(
      0,
      Math.floor(args.tailBytes ?? DEFAULT_TAIL_BYTES),
    );
    return await this.withSession(ctx, args, async (session) => {
      const r = await session.exec(["bash", "-c", STATUS_SCRIPT], {
        env: {
          TENKI_CVX_ID: args.processId,
          TENKI_CVX_TAIL: String(tailBytes),
        },
        timeoutMs: 30_000,
      });
      return parseStatus(new TextDecoder().decode(r.stdout), tailBytes);
    });
  }

  /** Signals the process and everything it started. */
  async kill(
    ctx: ActionCtx,
    args: Identity & { processId: string; signal?: Signal },
  ): Promise<{ signaled: boolean }> {
    requireProcessId(args.processId);
    const signal = args.signal ?? "TERM";
    if (!SIGNALS.includes(signal))
      throw new ConvexError({
        code: "invalid_argument",
        message: `bad signal ${signal}`,
      });
    return await this.withSession(ctx, args, async (session) => {
      const r = await session.exec(["bash", "-c", KILL_SCRIPT], {
        env: { TENKI_CVX_ID: args.processId, TENKI_CVX_SIGNAL: signal },
        timeoutMs: 30_000,
      });
      return {
        signaled: new TextDecoder().decode(r.stdout).trim() === "signaled",
      };
    });
  }

  async readFile(
    ctx: ActionCtx,
    args: Identity & { path: string },
  ): Promise<string>;
  async readFile(
    ctx: ActionCtx,
    args: Identity & { path: string; encoding: "bytes" },
  ): Promise<ArrayBuffer>;
  async readFile(
    ctx: ActionCtx,
    args: Identity & { path: string; encoding?: "utf8" | "bytes" },
  ): Promise<string | ArrayBuffer> {
    return await this.withSession(ctx, args, async (session) => {
      const bytes = await session.readFile(args.path);
      if (args.encoding === "bytes") return bytes.slice().buffer;
      return new TextDecoder().decode(bytes);
    });
  }

  async writeFile(
    ctx: ActionCtx,
    args: Identity & { path: string; data: string | ArrayBuffer },
  ): Promise<void> {
    const data =
      typeof args.data === "string" ? args.data : new Uint8Array(args.data);
    await this.withSession(
      ctx,
      args,
      async (session) => await session.writeFile(args.path, data),
    );
  }

  /** Returns a public URL for a port and records it on the row. */
  async exposePort(
    ctx: ActionCtx,
    args: Identity & { port: number; ttlMs?: number; slug?: string },
  ) {
    return await this.withSession(ctx, args, async (session, sandbox) => {
      const exposed = await session.exposePort(args.port, {
        ttlMs: args.ttlMs,
        slug: args.slug,
      });
      const preview = {
        port: exposed.port,
        url: exposed.previewUrl,
        ...(exposed.expiresAt
          ? { expiresAt: exposed.expiresAt.getTime() }
          : {}),
      };
      await ctx.runMutation(this.component.sandboxes.setPreview, {
        ...pick(args),
        sessionId: sandbox.sessionId!,
        preview,
      });
      return preview;
    });
  }

  async extend(ctx: ActionCtx, args: Identity & { additionalMs: number }) {
    return await this.withSession(ctx, args, async (session, sandbox) => {
      await session.extend(args.additionalMs);
      return await ctx.runMutation(this.component.sandboxes.sync, {
        ...pick(args),
        sessionId: sandbox.sessionId!,
        phase: phaseFromState(session.state),
        remote: summarize(session),
      });
    });
  }

  /**
   * Pauses the sandbox, keeping memory and disk. Takes tens of seconds; with
   * `wait: false` it returns `pausing` and a later `refresh` sees `paused`.
   */
  async pause(ctx: ActionCtx, args: Identity & { wait?: boolean }) {
    const identity = pick(args);
    return await this.withSession(ctx, args, async (session, sandbox) => {
      const sessionId = sandbox.sessionId!;
      await ctx.runMutation(this.component.sandboxes.sync, {
        ...identity,
        sessionId,
        phase: "pausing",
      });
      if (args.wait === false) {
        await session.pauseAsync();
      } else {
        // PauseSession can return while the session is still PAUSING.
        await session.pause();
        await session.waitPaused();
      }
      return await this.syncFromRemote(ctx, identity, sessionId);
    });
  }

  /** Resumes a paused sandbox and returns once commands run again. */
  async resume(ctx: ActionCtx, args: Identity) {
    const identity = pick(args);
    return await this.withSession(
      ctx,
      args,
      async (session, sandbox) => {
        const sessionId = sandbox.sessionId!;
        await ctx.runMutation(this.component.sandboxes.sync, {
          ...identity,
          sessionId,
          phase: "resuming",
        });
        await session.resume();
        await session.waitResumed();
        await waitForExec(session, RESUME_READY_MS);
        return await ctx.runMutation(this.component.sandboxes.sync, {
          ...identity,
          sessionId,
          phase: "ready",
          remote: summarize(session),
        });
      },
      ["paused", "pausing", "resuming", "ready"],
    );
  }

  /** Captures the sandbox's disk and memory; restore it with `create({ options: { snapshotId } })` or `fork`. */
  async snapshot(
    ctx: ActionCtx,
    args: Identity & { name?: string; expiresAt?: Date },
  ) {
    return await this.withSession(
      ctx,
      args,
      async (_session, sandbox) => {
        const snap = await this.client().createSnapshotAndWait(
          sandbox.sessionId!,
          {
            name: args.name,
            expiresAt: args.expiresAt,
          },
        );
        return await ctx.runMutation(this.component.sandboxes.recordSnapshot, {
          ...pick(args),
          sessionId: sandbox.sessionId!,
          snapshotId: snap.id,
          ...(args.name ? { name: args.name } : {}),
        });
      },
      ["ready", "paused"],
    );
  }

  /** Snapshots `from` and creates `to` from it. Both sandboxes keep running independently. */
  async fork(
    ctx: ActionCtx,
    args: {
      ownerId: string;
      from: string;
      to: string;
      name?: string;
      options?: CreateSandboxOptions;
    },
  ) {
    const snap = await this.snapshot(ctx, {
      ownerId: args.ownerId,
      key: args.from,
      name: args.name,
    });
    return await this.create(ctx, {
      ownerId: args.ownerId,
      key: args.to,
      options: { ...args.options, snapshotId: snap.snapshotId },
    });
  }

  /** Terminates the sandbox, including any orphan a crashed `create` left behind. */
  async destroy(ctx: ActionCtx, args: Identity) {
    const identity = pick(args);
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

  /**
   * Refreshes the least recently updated live sandboxes across all owners, so
   * rows catch up with sandboxes that timed out. Run it from a cron.
   */
  async reconcile(ctx: ActionCtx, args: { limit?: number } = {}) {
    const rows = await ctx.runQuery(this.component.sandboxes.stale, {
      limit: args.limit ?? 50,
    });
    let changed = 0;
    for (const row of rows) {
      try {
        const after = await this.syncFromRemote(ctx, pick(row), row.sessionId!);
        if (after?.phase !== row.phase) changed++;
      } catch {
        // Leave the row for the next run.
      }
    }
    return { checked: rows.length, changed };
  }

  async listSnapshots(ctx: ActionCtx, args: Identity & { limit?: number }) {
    return await ctx.runQuery(this.component.sandboxes.listSnapshots, {
      ...pick(args),
      limit: args.limit,
    });
  }

  /**
   * Runs `fn` against the row's live session. A session Tenki no longer has
   * marks the row terminated; a state conflict re-syncs it from Tenki.
   */
  private async withSession<T>(
    ctx: ActionCtx,
    args: Identity,
    fn: (
      session: SandboxSession,
      sandbox: { sessionId?: string; phase: Phase },
    ) => Promise<T>,
    allowed: readonly Phase[] = ["ready"],
  ): Promise<T> {
    const identity = pick(args);
    const sandbox = await this.get(ctx, identity);
    if (!sandbox?.sessionId) {
      throw new ConvexError({
        code: "not_found",
        message: `no sandbox for key "${identity.key}"`,
      });
    }
    if (!allowed.includes(sandbox.phase)) {
      throw new ConvexError({
        code: "not_ready",
        message: `sandbox is ${sandbox.phase}`,
        phase: sandbox.phase,
      });
    }
    const sessionId = sandbox.sessionId;
    try {
      return await fn(await this.session(sessionId), sandbox);
    } catch (err) {
      sessionCache.delete(sessionId);
      if (isGone(err)) {
        await ctx.runMutation(this.component.sandboxes.sync, {
          ...identity,
          sessionId,
          phase: "terminated",
        });
      } else if (describeError(err).code === "invalid_state") {
        await this.syncFromRemote(ctx, identity, sessionId).catch(() => {});
      }
      throw toConvexError(err);
    }
  }

  private async syncFromRemote(
    ctx: ActionCtx,
    identity: Identity,
    sessionId: string,
  ) {
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
      await sleep(WAIT_POLL_MS);
    }
  }
}

// Resume can report success before the guest agent answers again.
async function waitForExec(session: SandboxSession, timeoutMs: number) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const r = await session.exec(["true"], { timeoutMs: 10_000 });
      if (r.exitCode === 0) return;
    } catch (err) {
      if (isGone(err) || Date.now() > deadline) throw err;
    }
    if (Date.now() > deadline)
      throw new ConvexError({
        code: "resume_failed",
        message: "sandbox did not answer after resume",
      });
    await sleep(1_000);
  }
}

function pick(args: Identity): Identity {
  return { ownerId: args.ownerId, key: args.key };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
