# Tenki Sandboxes for Convex

Give every user or agent in your Convex app its own cloud machine.
[Tenki](https://tenki.cloud) sandboxes are microVMs that boot in about a second.
This component runs them from your Convex actions and keeps each sandbox's state
in a Convex table, so your UI updates live as a sandbox goes from `provisioning`
to `ready` to `paused`.

- **One sandbox per identity.** Sandboxes are keyed by `(ownerId, key)`.
  `create` is safe to retry and to call concurrently: you never get, or pay for,
  a second sandbox.
- **Crash-safe.** A `create` that dies mid-flight leaves a tagged session that
  the next call adopts. `destroy` also cleans up any such orphans.
- **Everything an agent needs:** shell commands, background processes, files,
  public preview URLs, pause/resume with memory intact, snapshots and forks.
- **The API key stays on the server** as a Convex environment variable.

## Install

```sh
npm install @tenkicloud/convex
npx convex env set TENKI_API_KEY tk_...
```

Create the API key in the Tenki dashboard. Then add the component to your app:

```ts
// convex/convex.config.ts
import { defineApp } from "convex/server";
import tenki from "@tenkicloud/convex/convex.config.js";

const app = defineApp();
app.use(tenki);

export default app;
```

## Usage

The Tenki SDK needs Node.js, so create and call `Tenki` from a `"use node"`
file:

```ts
// convex/sandboxes.ts
"use node";
import { getAuthUserId } from "@convex-dev/auth/server";
import { v } from "convex/values";
import { Tenki } from "@tenkicloud/convex";
import { action, type ActionCtx } from "./_generated/server";
import { components } from "./_generated/api";

const tenki = new Tenki(components.tenki, {
  defaults: { cpuCores: 2, memoryMb: 4096, maxDurationMs: 30 * 60_000 },
});

async function ownerId(ctx: ActionCtx) {
  const userId = await getAuthUserId(ctx);
  if (!userId) throw new Error("Unauthenticated");
  return userId;
}

export const start = action({
  args: {},
  handler: async (ctx) =>
    await tenki.create(ctx, { ownerId: await ownerId(ctx), key: "main" }),
});

export const run = action({
  args: { command: v.string() },
  handler: async (ctx, { command }) =>
    await tenki.exec(ctx, {
      ownerId: await ownerId(ctx),
      key: "main",
      command,
    }),
});
```

Queries read the component directly and run in Convex's default runtime, so the
UI can subscribe to a sandbox:

```ts
// convex/sandboxQueries.ts
import { getAuthUserId } from "@convex-dev/auth/server";
import { query } from "./_generated/server";
import { components } from "./_generated/api";

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const ownerId = await getAuthUserId(ctx);
    if (!ownerId) return null;
    return await ctx.runQuery(components.tenki.sandboxes.get, {
      ownerId,
      key: "main",
    });
  },
});
```

```tsx
const sandbox = useQuery(api.sandboxQueries.mine);
// sandbox?.phase: "provisioning" | "ready" | "pausing" | "paused" | "resuming" | "terminated" | "error"
```

`ownerId` is the only thing separating tenants. Always derive it from
`ctx.auth`, never from client input.

## API

Every method takes the action `ctx` and the sandbox's `{ ownerId, key }`.

### Lifecycle

- `create({ options? })` returns the sandbox, creating it if needed. If a
  concurrent call for the same identity fails, this one throws the same error.
  `options` takes any `@tenkicloud/sandbox` create option: resources, image,
  template, env, `allowDomains`, `maxDurationMs`, `snapshotId`, ...
- `pause({ wait? })` keeps memory and disk, so processes resume where they left
  off. It takes tens of seconds; with `wait: false` it returns `pausing` and a
  later `refresh` sees `paused`.
- `resume()` returns once commands run again.
- `extend({ additionalMs })` pushes the deadline out.
- `snapshot({ name? })` captures the sandbox; `listSnapshots()` lists them.
- `fork({ ownerId, from, to })` snapshots `from` and creates `to` from it. The
  two then run independently.
- `refresh()` re-reads the sandbox from Tenki.
- `destroy()` terminates it. The key can then be reused.
- `reconcile({ limit? })` refreshes the least recently updated live sandboxes
  across all owners. Run it from a cron so rows catch up with sandboxes that
  reached their deadline (see
  [`example/convex/crons.ts`](example/convex/crons.ts)).

### Commands and files

- `exec({ command, cwd?, env?, timeoutMs? })` runs a command and waits. A string
  runs under `bash -lc`; an array runs as argv. Output is capped at 1 MiB per
  stream and the timeout at 9 minutes, inside Convex's action limit.
- `spawn({ command, cwd?, env? })` starts a background command and returns a
  `processId` at once. It keeps running after the action ends and across
  pause/resume.
- `processStatus({ processId, tailBytes? })` returns `running`, `exited` (with
  `exitCode`), `killed`, or `lost` (ended without an exit, e.g. the sandbox
  restarted), plus the tail of its output.
- `kill({ processId, signal? })` signals the process and its children.
- `readFile({ path, encoding? })` returns a string, or an `ArrayBuffer` with
  `encoding: "bytes"`. `writeFile({ path, data })` takes either.
- `exposePort({ port, ttlMs?, slug? })` returns a public URL and records it in
  the row's `previews`.

### Reads

- `get()` / `list({ ownerId })` from an action. In queries, use
  `components.tenki.sandboxes.get` / `.list` directly.

### Errors

Errors are `ConvexError`s with a `code`:

| Code                                                     | Meaning                                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `not_found`                                              | No sandbox for this identity.                                                 |
| `not_ready`                                              | The row's `phase` doesn't allow the call; `phase` is included.                |
| `terminated`                                             | The sandbox is gone; the row is now `terminated`.                             |
| `invalid_state`                                          | Tenki refused the call in the sandbox's current state; the row was re-synced. |
| `insufficient_credits`                                   | The Tenki workspace's balance is empty.                                       |
| `capacity_exceeded`                                      | `maxActiveSandboxes` is reached; try again later.                             |
| `pause_failed`, `resume_failed`                          | Tenki couldn't pause or resume; the row was re-synced from Tenki.             |
| `provisioning_timeout`                                   | A concurrent `create` of the same identity is still provisioning.             |
| `file_not_found`                                         | `readFile` on a missing path.                                                 |
| `unauthenticated`                                        | `TENKI_API_KEY` is missing or invalid.                                        |
| `quota_exceeded`, `rate_limited`, `capacity_unavailable` | Tenki limits; retry later.                                                    |

A failed `create` also records the error on the row (`phase: "error"` and
`lastError`), and the next `create` retries.

## Limiting spend

`new Tenki(components.tenki, { maxActiveSandboxes: 20 })` refuses to start a
sandbox once 20 are active (not paused) across all owners, counting creates in
flight. The check runs in the same transaction that reserves the row, so
concurrent creates and forks can't exceed it.

## Lifetime

A Tenki sandbox has an absolute lifetime, set with `maxDurationMs` at create
time. Your workspace's limits set the default and the maximum. Activity does not
extend it; call `extend`. When it ends, the row keeps its last known phase until
`refresh` or `reconcile` runs.

## Example and demo

[`example/`](example) is a working app: a React page where each visitor signs in
anonymously, starts a sandbox, runs commands, serves a web page through a
preview URL, and pauses, resumes or forks it. See [docs/demo.md](docs/demo.md)
to run it.

## Contributing

[docs/architecture.md](docs/architecture.md) explains how the component works,
and [docs/testing.md](docs/testing.md) covers the test suites.
