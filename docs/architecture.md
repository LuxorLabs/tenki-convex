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
   token and a 5-minute lease, or reports the current holder. Convex runs
   mutations serializably, so exactly one caller holds the lease. Other callers
   wait for the row to leave `provisioning`. A terminated or failed row is
   reclaimed so the key can be reused.
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
session again, and it would keep billing until its deadline.

**Waiting on another caller.** A caller that finds another caller holding the
lease waits for the row to leave `provisioning`. If that create failed, the
waiting caller throws the same error, and after 3 minutes it throws
`provisioning_timeout`. It never returns a row that isn't usable.

**Capacity.** With `maxActiveSandboxes`, `claim` counts active rows (every live
phase except `paused`, including in-flight creates whose lease hasn't expired)
in the same transaction that reserves the row. Concurrent creates and forks
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
10-minute action limit, and it caps output at 1 MiB per stream so the result
fits in a Convex value.

## Background processes

A command run through `exec` dies when its stream ends, so `spawn` runs a fixed
script that starts the command under `setsid nohup` and returns. Each process
gets a directory, `<home>/.tenki-convex/proc/<processId>/`, holding:

- `pid`, and `start`: the process start time read from `/proc/<pid>/stat`
- `log` (combined stdout and stderr)
- `exit` (written to a temp file and renamed into place when the command exits,
  so a status check never reads a half-written code)
- `signal` (written by `kill`)

`<home>` is the user's home directory from the passwd entry, not `$HOME`, so a
`HOME` override in `spawn`'s `env` can't move the directory away from
`processStatus` and `kill`. A pid only counts as the process when its current
start time matches `start`, so after a restart a reused pid is reported as
`lost` and is never signaled.

`processStatus` and `kill` are fixed scripts too. User input reaches them only
through environment variables, never through string interpolation. `processId`s
are generated by the client and validated against `^[a-z0-9]{8,32}$`. The state
lives under `$HOME` rather than `/tmp`, because the SDK documents `/tmp` as
cleared across a pause.

A process started this way runs inside the guest agent's cgroup. It survives
pause and resume, but not a guest-agent restart; it then reports `lost`.

## Pause and resume

- **Pause.** A blocking `PauseSession` can return while the session is still
  `PAUSING`; in prod it returned after about 49s. `pause` therefore also waits
  for `PAUSED` (`waitPaused`) before syncing the row.
- **Resume.** Resume can report success before the guest agent answers again, so
  `resume` only marks the row `ready` after an `exec` of `true` succeeds.
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
  `invalid_state` error re-syncs the row.
- `reconcile` walks the least recently updated live rows that have a session
  (index `by_phase_updated`) and refreshes them. Customers run it from a cron. A
  row it fails to refresh is touched, so it goes to the back of the queue and
  can't starve the others.

## Errors

The client maps SDK errors to `ConvexError({ code, message })`. An empty
workspace balance arrives as a generic `failed_precondition`, so it's matched by
message and reported as `insufficient_credits`.
