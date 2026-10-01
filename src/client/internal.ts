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
  InvalidStateError: "invalid_state",
  FileNotFoundError: "file_not_found",
  SnapshotFailedError: "snapshot_failed",
  SnapshotWaitTimeoutError: "snapshot_failed",
  ResumeFailedError: "resume_failed",
  PortLimitExceededError: "port_limit_exceeded",
  InboundDisabledError: "inbound_disabled",
};

// Tenki reports an empty balance as a generic failed_precondition.
const NO_CREDITS = /balance is empty|top up/i;

export function describeError(err: unknown): { code: string; message: string } {
  if (err instanceof Error) {
    if (err.name === "InvalidStateError" && NO_CREDITS.test(err.message)) {
      return { code: "insufficient_credits", message: err.message };
    }
    return { code: ERROR_CODES[err.name] ?? "internal", message: err.message };
  }
  return { code: "internal", message: String(err) };
}

export function isGone(err: unknown): boolean {
  const code = describeError(err).code;
  return code === "not_found" || code === "terminated";
}

// Background processes outlive the exec that starts them; their state lives under
// $HOME because a pause wipes /tmp. Inputs arrive via env, never interpolated.
const PROC_ROOT = '"$HOME/.tenki-convex/proc/$TENKI_CVX_ID"';

export const SPAWN_SCRIPT = `set -e
D=${PROC_ROOT}
mkdir -p "$D"
export TENKI_CVX_DIR="$D"
setsid nohup bash -c 'cmd=$TENKI_CVX_CMD; dir=$TENKI_CVX_DIR; unset TENKI_CVX_CMD TENKI_CVX_DIR TENKI_CVX_ID; bash -lc "$cmd"; echo $? > "$dir/exit"' > "$D/log" 2>&1 < /dev/null &
echo $! > "$D/pid"
echo $!`;

export const STATUS_SCRIPT = `D=${PROC_ROOT}
[ -d "$D" ] || { echo missing; exit 0; }
size=$(wc -c < "$D/log" | tr -d ' ')
if [ -f "$D/exit" ]; then echo "exited $(cat "$D/exit") $size"
elif kill -0 "$(cat "$D/pid")" 2>/dev/null; then echo "running - $size"
elif [ -f "$D/signal" ]; then echo "killed $(cat "$D/signal") $size"
else echo "lost - $size"; fi
tail -c "$TENKI_CVX_TAIL" "$D/log"`;

export const KILL_SCRIPT = `D=${PROC_ROOT}
[ -f "$D/pid" ] || { echo missing; exit 0; }
if kill -s "$TENKI_CVX_SIGNAL" -- "-$(cat "$D/pid")" 2>/dev/null; then
  echo "$TENKI_CVX_SIGNAL" > "$D/signal"; echo signaled
else echo gone; fi`;

/** `lost`: ended without recording an exit, e.g. the sandbox restarted. */
export type ProcessState = "running" | "exited" | "killed" | "lost" | "missing";

export function parseStatus(stdout: string, tailBytes: number) {
  const newline = stdout.indexOf("\n");
  const head = newline === -1 ? stdout : stdout.slice(0, newline);
  const [state, exit, size] = head.trim().split(" ");
  if (state === "missing")
    return { state: "missing" as const, output: "", outputTruncated: false };
  const output = newline === -1 ? "" : stdout.slice(newline + 1);
  return {
    state: state as ProcessState,
    ...(state === "exited" ? { exitCode: Number(exit) } : {}),
    ...(state === "killed" ? { signal: exit } : {}),
    output,
    outputTruncated: Number(size) > tailBytes,
  };
}

const PROCESS_ID = /^[a-z0-9]{8,32}$/;

export function requireProcessId(processId: string) {
  if (!PROCESS_ID.test(processId))
    throw new Error(`invalid processId "${processId}"`);
}

export function newProcessId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 16);
}
