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
  cappedArgv,
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
  TAG_PREFIX,
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
  | "stat"
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
  getSnapshot(
    snapshotId: string,
  ): Promise<Pick<Snapshot, "cpuCores" | "memoryMb">>;
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
  /**
   * Refuse to start a new sandbox once this many are active (not paused) across
   * all owners, counting creates in flight; `create` then throws
   * `capacity_exceeded`. Checked in the same transaction that reserves the row.
   */
  maxActiveSandboxes?: number;
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
  /** Capped at 9 minutes so the call finishes inside Convex's action limit; 0 means the cap. */
  timeoutMs?: number;
  /** Per stream; output beyond it is dropped in the sandbox and flagged. Defaults to 1 MiB. */
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
// Convex's return value limit.
const DEFAULT_MAX_READ_BYTES = 16 << 20;
// Outlasts Convex's 10-minute action limit, so a lease only lapses once its holder is gone.
const CREATE_LEASE_MS = 10 * 60_000;
// Template-spec creates otherwise wait up to 2 hours for readiness.
const MAX_CREATE_WAIT_MS = 8 * 60_000;
const WAIT_FOR_PEER_MS = 3 * 60_000;
const WAIT_POLL_MS = 1_000;
const RESUME_READY_MS = 60_000;
// Resuming right after a deadline pause fails as unavailable until the old VM is gone.
const RESUME_RETRY_MS = 90_000;
const SETTLE_WAIT_MS = 2 * 60_000;
const NOT_FOUND_RETRY_MS = 1_000;
const FORK_SNAPSHOT_TTL_MS = 60 * 60_000;
const SESSION_CACHE_LIMIT = 64;
const TAG_PATTERN = /^[a-z0-9][a-z0-9_:.-]*$/i;
const SIGNALS: readonly Signal[] = ["TERM", "KILL", "INT", "HUP"];
// A snapshot brings its own machine, so these defaults are skipped when restoring one.
const SOURCE_OPTIONS = [
  "image",
  "fromTemplateSpec",
  "directRuntime",
  "cpuCores",
  "memoryMb",
  "diskSizeGb",
] as const;

// Action instances are reused while warm; a cached handle skips ~800ms of data-plane setup.
const sessionCache = new Map<string, SandboxSession>();

type ActionCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation"
>;

type Sandbox = NonNullable<Awaited<ReturnType<Tenki["get"]>>>;

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
   * Returns the sandbox for (ownerId, key), creating it if needed. A paused one
   * (including one Tenki paused at its deadline) is resumed unless `resume` is
   * false. Safe to retry and to call concurrently: one Tenki session exists per
   * identity.
   */
  async create(
    ctx: ActionCtx,
    args: Identity & { options?: CreateSandboxOptions; resume?: boolean },
  ): Promise<Sandbox> {
    const identity = pick(args);
    const tags = this.extraTags(args.options);
    for (let attempt = 0; ; attempt++) {
      const token = crypto.randomUUID();
      const { claimed, full, sandbox } = await this.claim(ctx, identity, token);
      if (full) throw capacityExceeded();
      if (claimed) {
        return await this.provision(ctx, identity, token, {
          ...args.options,
          tags,
        });
      }
      const current = leased(sandbox!)
        ? await this.waitForPeer(ctx, identity)
        : sandbox!;
      const usable = await this.recover(
        ctx,
        identity,
        current,
        args.resume !== false,
      );
      // A terminated row is reclaimed by the next claim.
      if (usable) return usable;
      if (attempt > 0) return current;
    }
  }

  private async claim(ctx: ActionCtx, identity: Identity, token: string) {
    return await ctx.runMutation(this.component.sandboxes.claim, {
      ...identity,
      token,
      leaseMs: CREATE_LEASE_MS,
      maxActive: this.options.maxActiveSandboxes,
    });
  }

  /** The defaults' and the caller's tags. */
  private extraTags(options?: CreateSandboxOptions): string[] {
    const tags = [
      ...(this.options.defaults?.tags ?? []),
      ...(options?.tags ?? []),
    ];
    // Tenki trims and lowercases tags, so only an already-valid tag can be checked for the prefix.
    const bad = tags.find(
      (t) => !TAG_PATTERN.test(t) || t.toLowerCase().startsWith(TAG_PREFIX),
    );
    if (bad !== undefined) {
      throw new ConvexError({
        code: "invalid_argument",
        message: `tag ${JSON.stringify(bad)} must match ${TAG_PATTERN} and not start with "${TAG_PREFIX}"`,
      });
    }
    return tags;
  }

  /** Creates or adopts the identity's session under the lease `token` holds. */
  private async provision(
    ctx: ActionCtx,
    identity: Identity,
    token: string,
    options: CreateSandboxOptions,
  ): Promise<Sandbox> {
    // Whatever session this call holds is closed if create fails, so a failed
    // create never leaves a billed sandbox that later calls would re-adopt.
    let held: SandboxSession | undefined;
    try {
      const sdk = this.client();
      const tag = await this.tag(identity);
      let session = canonical((await sdk.list({ tags: [tag] })).filter(isLive));
      held = session;
      if (!session) {
        const merged = await this.createOptions(sdk, options);
        const created = await sdk.create({
          ...merged,
          tags: [tag, ...(options.tags ?? [])],
          metadata: {
            ...this.options.defaults?.metadata,
            ...options.metadata,
            convex_namespace: this.namespace(),
            convex_owner_id: identity.ownerId,
            convex_key: identity.key,
          },
          waitReady: true,
          waitTimeoutMs: Math.min(
            merged.waitTimeoutMs ?? MAX_CREATE_WAIT_MS,
            MAX_CREATE_WAIT_MS,
          ),
        });
        held = created;
        session = await this.settleRace(sdk, tag, created);
        held = session;
      }
      if (session.state === "CREATING")
        await session.waitReady(MAX_CREATE_WAIT_MS);
      cacheSession(session);
      const result = await ctx.runMutation(this.component.sandboxes.complete, {
        ...identity,
        token,
        sessionId: session.id,
        phase: phaseFromState(session.state),
        remote: summarize(session),
      });
      if (result.accepted) return result.sandbox!;
      // The lease moved on: a destroy cancelled this create, or another create
      // took over an expired lease.
      held = undefined;
      if (releasable(result.sandbox, token, session.id)) {
        sessionCache.delete(session.id);
        await session.close().catch(() => {});
      }
      if (result.sandbox?.phase === "terminated") {
        throw new ConvexError({
          code: "terminated",
          message: "sandbox was destroyed while it was being created",
        });
      }
      return await this.waitForPeer(ctx, identity);
    } catch (err) {
      const orphan = held ?? (err as { session?: SandboxSession }).session;
      if (orphan) {
        const row = await this.get(ctx, identity).catch(() => null);
        if (releasable(row, token, orphan.id)) {
          sessionCache.delete(orphan.id);
          await orphan.close().catch(() => {});
        }
      }
      await ctx.runMutation(this.component.sandboxes.fail, {
        ...identity,
        token,
        ...describeError(err),
      });
      throw toConvexError(err);
    }
  }

  /**
   * Re-reads a row that may be stale and resumes it if asked. Returns null once
   * the session is gone, so the caller can create a new one.
   */
  private async recover(
    ctx: ActionCtx,
    identity: Identity,
    sandbox: Sandbox,
    resume: boolean,
  ): Promise<Sandbox | null> {
    // Includes a create that destroy cancelled before it recorded a session.
    if (sandbox.phase === "terminated") return null;
    const sessionId = sandbox.sessionId;
    if (!sessionId) return sandbox;
    const expired = (sandbox.remote?.timeoutAt ?? Infinity) <= Date.now();
    if (sandbox.phase === "ready" && !expired) return sandbox;
    const row =
      (await this.syncFromRemote(ctx, identity, sessionId)) ?? sandbox;
    if (row.phase === "terminated") return null;
    if (!resume || row.phase === "ready") return row;
    return await this.resume(ctx, identity);
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
    // The SDK treats 0 as no timeout.
    const timeoutMs =
      args.timeoutMs !== undefined && args.timeoutMs > 0
        ? Math.min(args.timeoutMs, MAX_EXEC_TIMEOUT_MS)
        : MAX_EXEC_TIMEOUT_MS;
    const requested = Math.floor(
      args.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
    );
    const maxOutputBytes = Number.isFinite(requested)
      ? Math.max(0, requested)
      : DEFAULT_MAX_OUTPUT_BYTES;
    const argv = cappedArgv(toArgv(args.command), maxOutputBytes + 1);
    return await this.withSession(ctx, args, async (session) => {
      const r = await session.exec(argv, {
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
        const stderr = new TextDecoder().decode(r.stderr).trim();
        throw new ConvexError({
          code: "spawn_failed",
          message:
            stderr ||
            `spawn exited with ${r.exitCode}${r.reason ? ` (${r.reason})` : ""}`,
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

  /** Files over `maxBytes` (default 16 MiB, Convex's return value limit) throw `file_too_large`. */
  async readFile(
    ctx: ActionCtx,
    args: Identity & { path: string; maxBytes?: number },
  ): Promise<string>;
  async readFile(
    ctx: ActionCtx,
    args: Identity & { path: string; encoding: "bytes"; maxBytes?: number },
  ): Promise<ArrayBuffer>;
  async readFile(
    ctx: ActionCtx,
    args: Identity & {
      path: string;
      encoding?: "utf8" | "bytes";
      maxBytes?: number;
    },
  ): Promise<string | ArrayBuffer> {
    const maxBytes = args.maxBytes ?? DEFAULT_MAX_READ_BYTES;
    return await this.withSession(ctx, args, async (session) => {
      const size = Number((await session.stat(args.path)).size);
      if (size > maxBytes) {
        throw new ConvexError({
          code: "file_too_large",
          message: `${args.path} is ${size} bytes; the limit is ${maxBytes}`,
          size,
        });
      }
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
      try {
        // A blocking PauseSession holds one request open for the whole pause.
        await session.pauseAsync();
        if (args.wait !== false) await session.waitPaused();
      } catch (err) {
        await this.syncFromRemote(ctx, identity, sessionId).catch(() => {});
        throw err;
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
        const { full, stale, phase } = await ctx.runMutation(
          this.component.sandboxes.beginResume,
          {
            ...identity,
            sessionId,
            maxActive: this.options.maxActiveSandboxes,
          },
        );
        if (full) throw capacityExceeded();
        if (stale) {
          throw new ConvexError({
            code: "not_ready",
            message: `sandbox is ${phase}`,
            phase: phase!,
          });
        }
        try {
          await this.startResume(session);
          await session.waitResumed();
          await waitForExec(session, RESUME_READY_MS);
        } catch (err) {
          await this.syncFromRemote(ctx, identity, sessionId).catch(() => {});
          throw err;
        }
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

  /**
   * Snapshots `from` and creates `to` from it. Both sandboxes keep running
   * independently. Throws `already_exists` while `to` is live or being created,
   * before taking the snapshot. The snapshot expires after an hour; Tenki
   * deletes it once no sandbox uses it.
   */
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
    const target = { ownerId: args.ownerId, key: args.to };
    const tags = this.extraTags(args.options);
    // Reserving the target first means a refused or losing fork never pays for a snapshot.
    const token = crypto.randomUUID();
    const { claimed, full } = await this.claim(ctx, target, token);
    if (full) throw capacityExceeded();
    if (!claimed) {
      throw new ConvexError({
        code: "already_exists",
        message: `sandbox "${args.to}" already exists; destroy it first`,
      });
    }
    let snapshotId: string;
    try {
      ({ snapshotId } = await this.snapshot(ctx, {
        ownerId: args.ownerId,
        key: args.from,
        name: args.name,
        expiresAt: new Date(Date.now() + FORK_SNAPSHOT_TTL_MS),
      }));
    } catch (err) {
      await ctx.runMutation(this.component.sandboxes.fail, {
        ...target,
        token,
        ...describeError(err),
      });
      throw toConvexError(err);
    }
    return await this.provision(ctx, target, token, {
      ...args.options,
      tags,
      snapshotId,
    });
  }

  /**
   * Terminates the sandbox, including any orphan a crashed `create` left behind,
   * and cancels a `create` still in flight.
   */
  async destroy(ctx: ActionCtx, args: Identity) {
    const identity = pick(args);
    const sdk = this.client();
    const tag = await this.tag(identity);
    const closed = new Set<string>();
    for (let round = 0; ; round++) {
      const sandbox = await this.get(ctx, identity);
      const tagged = (await sdk.list({ tags: [tag] })).filter(isLive);
      const ids = new Set(tagged.map((s) => s.id));
      if (sandbox?.sessionId) ids.add(sandbox.sessionId);
      for (const id of ids) {
        if (closed.has(id)) continue;
        sessionCache.delete(id);
        try {
          const session =
            tagged.find((s) => s.id === id) ?? (await this.getSession(id));
          await session.close();
        } catch (err) {
          if (!isGone(err)) throw toConvexError(err);
        }
        closed.add(id);
      }
      if (!sandbox) return null;
      const row = await ctx.runMutation(this.component.sandboxes.release, {
        ...identity,
        closed: [...closed],
      });
      // A create that finished after the listing recorded a session not yet closed.
      if (row?.phase === "terminated" || round >= 2) return row;
    }
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
        // Retried next run, after the rows that haven't been checked yet.
        await ctx.runMutation(this.component.sandboxes.touch, {
          ...pick(row),
          sessionId: row.sessionId!,
        });
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
      const session = await this.getSession(sessionId);
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
    const session = await this.getSession(sessionId);
    cacheSession(session);
    return session;
  }

  /**
   * Asks Tenki to resume. A session another call is already resuming needs no
   * request, a pause in flight has to reach PAUSED first, and right after a
   * deadline pause Tenki answers unavailable until the old VM is gone.
   */
  private async startResume(session: SandboxSession) {
    const deadline = Date.now() + RESUME_RETRY_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        return await session.resume();
      } catch (err) {
        const code = describeError(err).code;
        if (Date.now() > deadline) throw err;
        if (code === "invalid_state") {
          const { state } = await this.getSession(session.id);
          if (state === "RESUMING" || state === "RUNNING") return;
          if (state !== "PAUSING") throw err;
          await session.waitPaused(SETTLE_WAIT_MS).catch(() => {});
          continue;
        }
        if (code !== "unavailable") throw err;
      }
      await sleep(Math.min(2_000 * 2 ** attempt, 10_000));
    }
  }

  /** GetSession can read a lagging replica, so one miss doesn't mean the session is gone. */
  private async getSession(sessionId: string): Promise<SandboxSession> {
    try {
      return await this.client().get(sessionId);
    } catch (err) {
      if (describeError(err).code !== "not_found") throw err;
      await sleep(NOT_FOUND_RETRY_MS);
      return await this.client().get(sessionId);
    }
  }

  /**
   * Defaults, minus the ones that describe a machine when restoring a snapshot.
   * The guest gets the snapshot's size whatever is asked, but Tenki records the
   * size it was given, so that is the snapshot's too unless the caller sets one.
   */
  private async createOptions(
    sdk: SandboxClient,
    options: CreateSandboxOptions,
  ): Promise<CreateSandboxOptions> {
    if (!options.snapshotId) return { ...this.options.defaults, ...options };
    const defaults: CreateSandboxOptions = { ...this.options.defaults };
    for (const key of SOURCE_OPTIONS) delete defaults[key];
    const snap = await sdk.getSnapshot(options.snapshotId);
    return {
      ...defaults,
      ...(snap.cpuCores > 0 ? { cpuCores: snap.cpuCores } : {}),
      ...(snap.memoryMb > 0 ? { memoryMb: snap.memoryMb } : {}),
      ...options,
    };
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

  /** Waits for a concurrent create of the same identity, surfacing its failure. */
  private async waitForPeer(ctx: ActionCtx, identity: Identity) {
    const deadline = Date.now() + WAIT_FOR_PEER_MS;
    for (;;) {
      const sandbox = await this.get(ctx, identity);
      if (!sandbox) {
        throw new ConvexError({
          code: "not_found",
          message: `no sandbox for key "${identity.key}"`,
        });
      }
      if (sandbox.phase === "error") {
        throw new ConvexError({
          code: sandbox.lastError?.code ?? "internal",
          message: sandbox.lastError?.message ?? "create failed",
        });
      }
      if (!leased(sandbox)) return sandbox;
      if (Date.now() > deadline) {
        throw new ConvexError({
          code: "provisioning_timeout",
          message: "sandbox is still provisioning",
        });
      }
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

/** Whether a create holds the row's lease: one in progress, or one destroy cancelled that is still winding down. */
function leased(row: { phase: Phase; claim?: { expiresAt: number } }) {
  return (
    row.phase === "provisioning" ||
    (row.claim !== undefined && row.claim.expiresAt > Date.now())
  );
}

/**
 * Whether a create may close a session it holds once its lease is gone: not if
 * the row records it, nor while another create holds the lease and may adopt it.
 */
function releasable(
  row: {
    phase: Phase;
    sessionId?: string;
    claim?: { token: string };
  } | null,
  token: string,
  sessionId: string,
): boolean {
  if (!row) return true;
  if (row.sessionId === sessionId) return false;
  return !(
    row.phase === "provisioning" &&
    row.claim &&
    row.claim.token !== token
  );
}

function capacityExceeded() {
  return new ConvexError({
    code: "capacity_exceeded",
    message: "Too many active sandboxes; try again later",
  });
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
