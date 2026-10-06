# Architecture

The package has two halves:

- **The component** (`src/component/`) runs inside the customer's Convex
  deployment. It owns two tables, `sandboxes` and `snapshots`, plus the queries
  and mutations that change them. It never calls Tenki.
- **The client** (`src/client/`) is the `Tenki` class. It runs in the customer's
  own `"use node"` actions, calls Tenki through `@tenkicloud/sandbox`, and
  writes what it sees through the component's mutations.

## Why the SDK runs in the customer's action

Convex components can't contain `"use node"` files (the CLI rejects them), and
the Tenki SDK needs Node: it speaks gRPC over HTTP/2, and command execution uses
a bidirectional stream (`SandboxSessionDataPlaneService.Run`). Neither works
over `fetch` in Convex's default runtime. So the SDK lives in the client class,
and any file that calls `Tenki` must be `"use node"`.

Queries never need the SDK; they read the component's tables directly. Importing
`Tenki` from a non-Node file fails the Convex build with "Could not resolve
node:http2".

The control plane does accept Connect JSON over HTTP/1.1, so a `fetch`-only
version is possible later if the data plane gains a unary exec.

## The `sandboxes` row

One row per `(ownerId, key)`:

| Field       | Meaning                                                                         |
| ----------- | ------------------------------------------------------------------------------- |
| `phase`     | `provisioning`, `ready`, `pausing`, `paused`, `resuming`, `terminated`, `error` |
| `sessionId` | The Tenki session, once known                                                   |
| `claim`     | The creation lease (see below)                                                  |
| `remote`    | Last observed Tenki state, deadline and resources                               |
| `previews`  | Exposed ports and their URLs                                                    |
| `lastError` | Why the last `create` failed                                                    |

`sync` only applies to the row if the row still points at the same `sessionId`,
so a late update from an old session can't overwrite a newer one.

## Idempotent create

`create` has to guarantee one Tenki session per identity even when it is
retried, called concurrently, or killed halfway. `CreateSession` has no
idempotency key, so three layers do the work:

1. **Lease.** The `claim` mutation inserts the row as `provisioning` with a
   token and a 10-minute lease, or reports the current holder. The lease
   outlasts Convex's 10-minute action limit, and readiness waits are capped at 8
   minutes, so it only lapses once its holder is gone. Convex runs mutations
   serializably, so exactly one caller holds the lease. Other callers wait for
   the row to leave `provisioning`. A terminated or failed row is reclaimed so
   the key can be reused.
2. **Adoption tag.** Every session is tagged
   `cvx:<sha256(namespace, ownerId, key)[:28]>`. Before creating, the lease
   holder lists sessions with that tag and adopts a live one. That recovers from
   an action that died after `CreateSession` but before recording the session.
   The hash keeps the tag inside Tenki's limit (32 lowercase characters). The
   raw values go in session `metadata` for debugging. `TERMINATING` sessions
   still show up in listings and are never adopted.
3. **Race settlement.** After creating, the holder lists the tag again. If a
   racing creator made another session, everyone keeps the oldest one (session
   ids are UUIDv7, so they sort by creation time) and terminates the rest.

**Failure cleanup.** If `create` fails after a session exists, it closes that
session before recording the error. That covers a session it created whose
readiness wait failed (the SDK's error carries it) and an adopted session that
never became ready. Otherwise the next `create` would adopt the same broken
session again, and it would keep billing until its deadline. It first checks
that the lease is still its own: a session the row records, or one another
create holding the lease may adopt, is left alone.

**Cancellation.** `destroy` closes the tagged sessions and the row's session,
then the `release` mutation marks the row `terminated` and drops the lease. A
create still in flight then has its `complete` rejected, closes the session it
made, and throws `terminated`. If a create recorded a session `destroy` hadn't
seen, `destroy` goes round again.

**Existing rows.** A caller that finds a row already past `provisioning`
re-reads it from Tenki unless it is `ready` with its deadline ahead. A paused
row is resumed (unless `resume: false`), a `pausing` one first waits for
`PAUSED`, and a terminated one is reclaimed and created anew.

**Waiting on another caller.** A caller that finds another caller holding the
lease waits for the row to leave `provisioning`. If that create failed, the
waiting caller throws the same error, and after 3 minutes it throws
`provisioning_timeout`. It never returns a row that isn't usable.

**Capacity.** With `maxActiveSandboxes`, `claim` counts active rows (every live
phase except `paused`, including in-flight creates whose lease hasn't expired)
in the same transaction that reserves the row. `beginResume` does the same
before a paused row turns `resuming`. Concurrent creates, forks and resumes
can't get past the cap.

**Namespace.** The namespace defaults to the deployment's `CONVEX_CLOUD_URL`, so
a dev and a prod deployment sharing one Tenki workspace never adopt each other's
sessions.

## Session handles

Calling Tenki from a fresh action costs about 1s per call: a `GetSession`, then
data-plane credentials and connection setup. The client keeps up to 64 session
handles at module scope. Convex reuses warm action instances, and a cached
handle brings `exec` down to about 280ms.

The cache is best effort: instances recycle often, and any error evicts the
handle.

## Commands

`exec` wraps a string in `bash -lc` (the SDK otherwise treats it as a program
name). It caps the timeout at 9 minutes so the call finishes inside Convex's
10-minute action limit; 0, which the SDK reads as no timeout, also means 9
minutes.

The SDK holds a command's whole output in memory, including through `run()`, so
output is capped in the guest: every command runs under a fixed `bash -c` script
that points its stdout and stderr at `head -c` processes that drain the rest,
then `exec`s the command. The guest agent signals only the process it started,
so the command has to be that process: its timeout then reaches the command, and
its exit status and signal are reported as before. The client asks for one byte
more than `maxOutputBytes` (1 MiB by default) so it can flag truncation. The
result fits in a Convex value, and a command that prints gigabytes costs the
action nothing.

## Background processes

A command run through `exec` dies when its stream ends, so `spawn` runs a fixed
script that starts the command under `setsid` and returns. A background job of a
non-interactive shell ignores `INT` and `QUIT`, so where `env --default-signal`
exists the command starts with default signal handlers; elsewhere it falls back
to `nohup`, and `INT` and `HUP` have no effect. Each process gets a directory,
`<home>/.tenki-convex/proc/<processId>/`, holding:

- `pid`, and `start`: the process start time read from `/proc/<pid>/stat`
- `log` (combined stdout and stderr)
- `exit` (written to a temp file and renamed into place when the command exits,
  so a status check never reads a half-written code)
- `signal` (written by `kill`)

`<home>` is the user's home directory from the passwd entry, not `$HOME`, so a
`HOME` override in `spawn`'s `env` can't move the directory away from
`processStatus` and `kill`. A pid only counts as the process when its current
start time matches `start`, so after a restart a reused pid is reported as
`lost` and is never signaled. `setsid` makes the pid the process group id, and
Linux doesn't reuse a pid while its group has members, so once the pid has
exited, any process left in that group (say, a server the command started with
`&`) keeps the status `running`, and `kill` signals the group.

`processStatus` and `kill` are fixed scripts too. User input reaches them only
through environment variables, never through string interpolation. `processId`s
are generated by the client and validated against `^[a-z0-9]{8,32}$`. The state
lives under `$HOME` rather than `/tmp`, because the SDK documents `/tmp` as
cleared across a pause.

A process started this way runs inside the guest agent's cgroup. It survives
pause and resume, but not a guest-agent restart; it then reports `lost`.

## Pause and resume

- **Pause.** A blocking `PauseSession` holds one request open for the whole
  pause (about 49s in prod) and can still return while the session is `PAUSING`.
  `pause` starts it asynchronously and polls for `PAUSED` (`waitPaused`) before
  syncing the row.
- **Resume.** Resume can report success before the guest agent answers again, so
  `resume` only marks the row `ready` after an `exec` of `true` succeeds. Right
  after a deadline pause, Tenki refuses a resume as `unavailable` until the old
  VM is torn down (about 30s in prod), so `resume` retries that for up to 90s.
- **Failures.** If pausing or resuming fails or times out, the row is re-synced
  from Tenki before the error is thrown, so it never stays `pausing` or
  `resuming`.
- **Guest shutdown.** A shutdown from inside the guest (`USER_SHUTDOWN`) is
  stopped but resumable, so the row shows `paused`.

## Drift and `reconcile`

Tenki ends sandboxes on its own schedule: at the deadline, used sandboxes are
paused and unused ones are terminated. Nothing notifies Convex when that
happens.

Rows catch up in three ways:

- `refresh` re-reads one sandbox.
- Any call that hits a gone session marks the row `terminated`, and an
  `invalid_state` error re-syncs the row. `GetSession` can read a lagging
  replica, so a session is only treated as gone after a second miss a second
  later.
- `create` re-reads a row that isn't `ready` or whose deadline has passed.
- `reconcile` walks the least recently updated live rows that have a session
  (index `by_phase_updated`) and refreshes them. Customers run it from a cron. A
  row it fails to refresh is touched, so it goes to the back of the queue and
  can't starve the others.

## Errors

The client maps SDK errors to `ConvexError({ code, message })`, by error class
where the SDK has one. The SDK leaves `invalid_argument`, `unavailable` and
`deadline_exceeded` as a generic `SandboxError`, so those are read from the
`[code]` prefix of its message, and its readiness waits throw plain `Error`s
that are matched by message (`terminated`, `timeout`). An empty workspace
balance arrives as a generic `failed_precondition`, so it's matched by message
and reported as `insufficient_credits`.
