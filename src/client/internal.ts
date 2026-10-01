import type { Infer } from "convex/values";
import type { phaseValidator, remoteValidator } from "../component/schema.js";

export type Phase = Infer<typeof phaseValidator>;
export type RemoteSummary = Infer<typeof remoteValidator>;

/** The subset of a `@tenkicloud/sandbox` Session this package relies on. */
export interface SessionLike {
  id: string;
  state: string;
  timeoutAt?: Date;
  cpuCores: number;
  memoryMb: number;
  diskSizeGb: number;
  sticky: boolean;
}

const TAG_PREFIX = "cvx:";
// Tenki tags are capped at 32 chars of [a-z0-9_:.-], so identities are hashed.
const TAG_HASH_CHARS = 32 - TAG_PREFIX.length;

export async function adoptionTag(
  namespace: string,
  ownerId: string,
  key: string,
): Promise<string> {
  const bytes = new TextEncoder().encode(`${namespace}\n${ownerId}\n${key}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join(
    "",
  );
  return TAG_PREFIX + hex.slice(0, TAG_HASH_CHARS);
}

export function phaseFromState(state: string): Phase {
  switch (state) {
    case "RUNNING":
      return "ready";
    case "PAUSING":
      return "pausing";
    case "PAUSED":
      return "paused";
    case "RESUMING":
      return "resuming";
    case "USER_SHUTDOWN":
    case "TERMINATING":
    case "TERMINATED":
      return "terminated";
    default:
      return "provisioning";
  }
}

/** Listing returns TERMINATING sessions; they must never be adopted. */
export function isLive(session: { state: string }): boolean {
  return phaseFromState(session.state) !== "terminated";
}

export function summarize(session: SessionLike): RemoteSummary {
  const timeoutAt = session.timeoutAt?.getTime();
  return {
    state: session.state,
    ...(timeoutAt && Number.isFinite(timeoutAt) && timeoutAt > 0
      ? { timeoutAt }
      : {}),
    cpuCores: session.cpuCores,
    memoryMb: session.memoryMb,
    diskSizeGb: session.diskSizeGb,
    sticky: session.sticky,
  };
}

/** UUIDv7 session ids sort by creation time; the oldest live session wins a race. */
export function canonical<T extends { id: string }>(
  sessions: T[],
): T | undefined {
  return sessions.reduce<T | undefined>(
    (min, s) => (!min || s.id < min.id ? s : min),
    undefined,
  );
}

export function truncateUtf8(
  bytes: Uint8Array,
  maxBytes: number,
): { text: string; truncated: boolean } {
  const truncated = bytes.byteLength > maxBytes;
  return {
    text: new TextDecoder().decode(
      truncated ? bytes.subarray(0, maxBytes) : bytes,
    ),
    truncated,
  };
}

export function toArgv(command: string | string[]): string[] {
  if (typeof command === "string") return ["bash", "-lc", command];
  if (command.length === 0) throw new Error("command must not be empty");
  return command;
}

const ERROR_CODES: Record<string, string> = {
  MissingAuthTokenError: "unauthenticated",
  InvalidAuthTokenError: "unauthenticated",
  UnauthorizedError: "unauthenticated",
  PermissionDeniedError: "permission_denied",
  QuotaExceededError: "quota_exceeded",
  CapacityUnavailableError: "capacity_unavailable",
  RateLimitedError: "rate_limited",
  InvalidResourceConfigError: "invalid_argument",
  SessionNotFoundError: "not_found",
  SessionTerminatedError: "terminated",
  SessionExpiredError: "terminated",
};

export function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    return { code: ERROR_CODES[err.name] ?? "internal", message: err.message };
  }
  return { code: "internal", message: String(err) };
}

export function isGone(err: unknown): boolean {
  const code = describeError(err).code;
  return code === "not_found" || code === "terminated";
}
