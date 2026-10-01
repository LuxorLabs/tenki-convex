# Tenki Sandboxes for Convex

Run [Tenki](https://tenki.cloud) sandboxes (cloud microVMs for AI agents) from
your Convex backend. Each sandbox's state lives in a Convex table, so your UI
updates live as it goes from `provisioning` to `ready`.

- **One sandbox per identity.** Sandboxes are keyed by `(ownerId, key)`.
  `create` is safe to retry and to call concurrently: you never get, or pay for,
  a second sandbox.
- **Crash-safe.** A `create` that dies mid-flight leaves a tagged session that
  the next call adopts. `destroy` also cleans up any such orphans.
- **The API key stays on the server** as a Convex environment variable.

> Status: early development. The API below may change before 1.0.

## Install

```sh
npm install @tenkicloud/convex
npx convex env set TENKI_API_KEY tk_...
```

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
import { v } from "convex/values";
import { Tenki } from "@tenkicloud/convex";
import { action } from "./_generated/server";
import { components } from "./_generated/api";

const tenki = new Tenki(components.tenki, {
  defaults: { cpuCores: 2, memoryMb: 4096 },
});

async function userId(ctx: {
  auth: { getUserIdentity(): Promise<{ subject: string } | null> };
}) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new Error("Unauthenticated");
  return identity.subject;
}

export const create = action({
  args: {},
  handler: async (ctx) =>
    await tenki.create(ctx, { ownerId: await userId(ctx), key: "main" }),
});

export const run = action({
  args: { command: v.string() },
  handler: async (ctx, { command }) =>
    await tenki.exec(ctx, { ownerId: await userId(ctx), key: "main", command }),
});
```

Queries read the component directly and run in Convex's default runtime:

```ts
// convex/sandboxQueries.ts
import { query } from "./_generated/server";
import { components } from "./_generated/api";

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) return null;
    return await ctx.runQuery(components.tenki.sandboxes.get, {
      ownerId: identity.subject,
      key: "main",
    });
  },
});
```

`ownerId` is the only thing separating tenants. Always derive it from
`ctx.auth`, never from client input.

### API

Every method takes the action `ctx` and the sandbox's `{ ownerId, key }`.

**Lifecycle**

- `create({ options? })` returns the sandbox, creating it if needed. `options`
  takes any `@tenkicloud/sandbox` create option: resources, image, template,
  env, `maxDurationMs`, `snapshotId`, ...
- `pause({ wait? })` keeps memory and disk; it takes tens of seconds. With
  `wait: false` it returns `pausing`, and a later `refresh` sees `paused`.
- `resume()` returns once commands run again.
- `extend({ additionalMs })` pushes the deadline out.
- `snapshot({ name? })` captures the sandbox; `listSnapshots()` lists them.
- `fork({ ownerId, from, to })` snapshots `from` and creates `to` from it.
- `refresh()` re-reads the sandbox from Tenki.
- `destroy()` terminates it. The key can then be reused.
- `reconcile({ limit? })` refreshes the least recently updated live sandboxes
  across all owners. Run it from a cron (see `example/convex/crons.ts`) so rows
  catch up with sandboxes that reached their deadline.

**Commands and files**

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

**Reads**

- `get()` / `list({ ownerId })` from an action. In queries, use
  `components.tenki.sandboxes.get` / `.list` directly.

Errors are `ConvexError`s with a `code`, such as `not_found`, `not_ready` (the
row's `phase` doesn't allow the call), `terminated`, `invalid_state`,
`file_not_found`, `unauthenticated`, `quota_exceeded` or `rate_limited`.

### Lifetime

A Tenki sandbox has an absolute lifetime, set with `maxDurationMs` at create
time. Your workspace's limits set the default and the maximum. Activity does not
extend it; call `extend`. When it ends, the row keeps its last known phase until
`refresh` or `reconcile` runs.

## Development

```sh
npm install
npm run dev     # local Convex backend + component rebuilds
npm test        # unit tests (no network)
npm run e2e     # against a running `npm run dev` and real Tenki; see below
```

`npm run e2e` drives the example app in `example/convex` against the Tenki
account behind `TENKI_API_KEY`. That key must be set both on the Convex
deployment (`npx convex env set TENKI_API_KEY`) and in your shell. Every sandbox
the run creates is tagged `cvx-e2e:<run>` and terminated at the end; the run
fails if any are left.
