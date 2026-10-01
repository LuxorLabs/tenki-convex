import { test } from "vitest";
import type { CreateOptions, ListOptions } from "@tenkicloud/sandbox";
import type { SandboxClient, SandboxSession } from "./index.js";

export type FakeSession = SandboxSession & {
  tags: string[];
  metadata: Record<string, string>;
  argv: string[][];
};

export function sdkError(name: string, message = name): Error {
  return Object.assign(new Error(message), { name });
}

/** In-memory stand-in for the Tenki control plane. */
export class FakeSdk implements SandboxClient {
  sessions = new Map<string, FakeSession>();
  creates: CreateOptions[] = [];
  createDelayMs = 0;
  failCreate?: Error;
  execResult: {
    exitCode: number;
    stdout: Uint8Array;
    stderr: Uint8Array;
    reason?: string;
    durationMs: number;
  } = {
    exitCode: 0,
    stdout: new TextEncoder().encode("ok\n"),
    stderr: new Uint8Array(),
    reason: "exit",
    durationMs: 5,
  };
  execError?: Error;
  execOptions: unknown[] = [];
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
    if (this.failCreate) throw this.failCreate;
    const session = this.make(
      this.nextId(),
      options.tags ?? [],
      options.metadata ?? {},
      "RUNNING",
    );
    this.sessions.set(session.id, session);
    return session;
  }

  async get(sessionId: string): Promise<SandboxSession> {
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

  private make(
    id: string,
    tags: string[],
    metadata: Record<string, string>,
    state: string,
  ): FakeSession {
    const execResult = () => this.execResult;
    const execError = () => this.execError;
    const execOptions = this.execOptions;
    const session: FakeSession = {
      id,
      state: state as SandboxSession["state"],
      timeoutAt: new Date(Date.now() + 30 * 60_000),
      cpuCores: 2,
      memoryMb: 4096,
      diskSizeGb: 20,
      sticky: false,
      tags,
      metadata,
      argv: [],
      async exec(command, options) {
        session.argv.push(command as string[]);
        execOptions.push(options);
        const error = execError();
        if (error) throw error;
        return {
          ...execResult(),
          sessionId: id,
          command: "",
          args: [],
          status: "COMPLETED",
          outputs: [],
        } as never;
      },
      async close() {
        session.state = "TERMINATING";
      },
      async waitReady() {
        session.state = "RUNNING";
      },
    };
    return session;
  }
}

test("fake", () => {});
