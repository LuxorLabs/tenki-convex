import { test } from "vitest";
import type {
  CreateOptions,
  CreateSnapshotOptions,
  ListOptions,
} from "@tenkicloud/sandbox";
import type { SandboxClient, SandboxSession } from "./index.js";

export type FakeSession = SandboxSession & {
  tags: string[];
  metadata: Record<string, string>;
  argv: string[][];
  files: Map<string, Uint8Array>;
};

type ExecReply = {
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
  reason?: string;
  durationMs: number;
};
type ExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
};

export function sdkError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

export const text = (s: string) => new TextEncoder().encode(s);

/** In-memory stand-in for the Tenki control plane. */
export class FakeSdk implements SandboxClient {
  sessions = new Map<string, FakeSession>();
  creates: CreateOptions[] = [];
  snapshots: { sessionId: string; options?: CreateSnapshotOptions }[] = [];
  private snapshotSizes = new Map<
    string,
    { cpuCores: number; memoryMb: number }
  >();
  createDelayMs = 0;
  lifetimeMs = 30 * 60_000;
  failCreate?: Error;
  /** Runs inside `create` after any delay, before the session exists. */
  onCreate?: () => Promise<void>;
  /** Thrown by `create` after the session exists, carrying it like WaitReadyFailedError. */
  failCreateAfterSession?: string;
  failWaitReady?: Error;
  failPause?: Error;
  failResume?: Error;
  /** Errors `resume` throws, one per call, before it succeeds. */
  resumeErrors: Error[] = [];
  /** Session ids whose next `get` misses, as a lagging replica would. */
  lagging = new Set<string>();
  execResult: ExecReply = {
    exitCode: 0,
    stdout: text("ok\n"),
    stderr: new Uint8Array(),
    reason: "exit",
    durationMs: 5,
  };
  execError?: Error;
  onExec?: (argv: string[], options: ExecOptions) => ExecReply | Error;
  execOptions: ExecOptions[] = [];
  private static seq = 100;

  seed(tags: string[], state = "RUNNING", id = this.nextId()): FakeSession {
    const session = this.make(id, tags, {}, state);
    this.sessions.set(id, session);
    return session;
  }

  nextId(): string {
    return `01a0f900-0000-7000-8000-${String(FakeSdk.seq++).padStart(12, "0")}`;
  }

  async create(options: CreateOptions): Promise<SandboxSession> {
    this.creates.push(options);
    if (this.createDelayMs)
      await new Promise((r) => setTimeout(r, this.createDelayMs));
    await this.onCreate?.();
    if (this.failCreate) throw this.failCreate;
    if (this.failCreateAfterSession) {
      const stuck = this.make(
        this.nextId(),
        options.tags ?? [],
        options.metadata ?? {},
        "CREATING",
      );
      this.sessions.set(stuck.id, stuck);
      throw Object.assign(sdkError(this.failCreateAfterSession), {
        session: stuck,
      });
    }
    const session = this.make(
      this.nextId(),
      options.tags ?? [],
      options.metadata ?? {},
      "RUNNING",
    );
    session.cpuCores = options.cpuCores ?? session.cpuCores;
    session.memoryMb = options.memoryMb ?? session.memoryMb;
    this.sessions.set(session.id, session);
    return session;
  }

  async get(sessionId: string): Promise<SandboxSession> {
    if (this.lagging.delete(sessionId)) throw sdkError("SessionNotFoundError");
    const session = this.sessions.get(sessionId);
    if (!session) throw sdkError("SessionNotFoundError");
    return session;
  }

  async list(options: ListOptions): Promise<SandboxSession[]> {
    return [...this.sessions.values()].filter(
      (s) =>
        s.state !== "TERMINATED" &&
        (options.tags ?? []).every((t) => s.tags.includes(t)),
    );
  }

  async createSnapshotAndWait(
    sessionId: string,
    options?: CreateSnapshotOptions,
  ) {
    this.snapshots.push({ sessionId, options });
    const id = `snap-${this.snapshots.length}`;
    const source = this.sessions.get(sessionId)!;
    this.snapshotSizes.set(id, {
      cpuCores: source.cpuCores,
      memoryMb: source.memoryMb,
    });
    return { id };
  }

  async getSnapshot(snapshotId: string) {
    const size = this.snapshotSizes.get(snapshotId);
    if (!size) throw sdkError("SnapshotNotFoundError", "snapshot not found");
    return size;
  }

  private make(
    id: string,
    tags: string[],
    metadata: Record<string, string>,
    state: string,
  ): FakeSession {
    const sdk = () => this;
    const session: FakeSession = {
      id,
      state: state as SandboxSession["state"],
      timeoutAt: new Date(Date.now() + this.lifetimeMs),
      cpuCores: 2,
      memoryMb: 4096,
      diskSizeGb: 20,
      sticky: false,
      tags,
      metadata,
      argv: [],
      files: new Map(),
      async exec(command, options) {
        const argv = command as string[];
        session.argv.push(argv);
        sdk().execOptions.push(options ?? {});
        if (sdk().execError) throw sdk().execError;
        const reply = sdk().onExec?.(argv, options ?? {}) ?? sdk().execResult;
        if (reply instanceof Error) throw reply;
        return {
          ...reply,
          sessionId: id,
          command: argv[0],
          args: argv.slice(1),
          status: "COMPLETED",
          outputs: [],
        } as never;
      },
      async close() {
        session.state = "TERMINATING";
      },
      async waitReady() {
        if (sdk().failWaitReady) throw sdk().failWaitReady;
        session.state = "RUNNING";
      },
      async pause() {
        session.state = "PAUSING";
      },
      async waitPaused() {
        session.state = "PAUSED";
      },
      async pauseAsync() {
        // A failed pause reverts the session to RUNNING, as PauseFailedError reports.
        if (sdk().failPause) throw sdk().failPause;
        session.state = "PAUSING";
      },
      async resume() {
        const err = sdk().resumeErrors.shift();
        if (err) throw err;
        session.state = "RESUMING";
      },
      async waitResumed() {
        // A failed resume leaves the session stopped, as ResumeFailedError reports.
        if (sdk().failResume) {
          session.state = "PAUSED";
          throw sdk().failResume;
        }
        session.state = "RUNNING";
      },
      async extend(ms) {
        session.timeoutAt = new Date(session.timeoutAt.getTime() + ms);
      },
      async stat(path) {
        const data = session.files.get(path);
        if (!data) throw sdkError("FileNotFoundError", path);
        return {
          path,
          size: BigInt(data.byteLength),
          mode: 0o644,
          isDir: false,
          modifiedUnixNs: 0n,
        };
      },
      async readFile(path) {
        const data = session.files.get(path);
        if (!data) throw sdkError("FileNotFoundError", path);
        return data;
      },
      async writeFile(path, data) {
        session.files.set(path, typeof data === "string" ? text(data) : data);
      },
      async exposePort(port, options) {
        return {
          port,
          previewUrl: `https://${options?.slug ?? "p"}-${port}.preview.test`,
          expiresAt: options?.ttlMs
            ? new Date(Date.now() + options.ttlMs)
            : undefined,
          wildcard: false,
          wildcardStatus: "UNSPECIFIED",
          wildcardStatusReason: "",
        };
      },
    };
    return session;
  }
}

test("fake", () => {});
