# Testing

| Suite      | Command                  | Network | Runs in CI                                              |
| ---------- | ------------------------ | ------- | ------------------------------------------------------- |
| Unit       | `npm test`               | None    | Every push and PR (`test.yml`)                          |
| Pack check | `npm run pack:check`     | npm     | Every push and PR (`test.yml`)                          |
| E2E        | `npm run e2e`            | Tenki   | Every push and PR, nightly with slow checks (`e2e.yml`) |
| Sweeper    | `node scripts/sweep.mjs` | Tenki   | Hourly (`sweep.yml`)                                    |

## Unit tests

`convex-test` runs the component's functions in memory. The client tests drive
`Tenki` through test actions with `FakeSdk` (`src/client/fake.test.ts`) in place
of `@tenkicloud/sandbox`. The fake mirrors prod behavior that matters to the
client: closed sessions list as `TERMINATING`, and `pause` returns before the
session is `PAUSED`.

`src/client/scripts.test.ts` runs the real background-process scripts under
`bash`. It needs `setsid`, so it is skipped on macOS and runs on Linux CI.

## Pack check

`scripts/pack-check.sh` installs the `npm pack` tarball into a fresh project,
type-checks a component install and a `Tenki` call against it with
`skipLibCheck: false`, and imports it at runtime. It catches broken `exports`
and missing files before a release.

## E2E

`scripts/e2e.mjs` drives the example app's e2e harness (`example/convex/e2e.ts`)
on a running Convex deployment against real Tenki. It covers:

- create, the live subscription, idempotency under concurrency, and orphan
  adoption
- error recording, owner isolation, files, background processes, and public
  preview URLs
- extend, pause/resume, kill, fork, reconcile, and destroy with key reuse

With `E2E_SLOW=1` it also lets a 60-second sandbox reach its real deadline and
checks that `reconcile` catches the row up. This adds about 80s.

Every sandbox the run creates is tagged `cvx-e2e:<run>` and terminated at the
end; the run fails if any remain. Scenarios destroy what they create, so at most
two sandboxes are alive at once.

The harness takes `ownerId` from its caller, so every function in it refuses to
run unless `TENKI_E2E=1` is set on the deployment. Never set it on a deployment
that serves the demo.

### Running locally

```sh
npm run build
CONVEX_AGENT_MODE=anonymous npx convex dev      # local backend, leave running
npx convex env set TENKI_API_KEY                 # paste the key; stdin keeps it out of history
npx convex env set TENKI_E2E 1
TENKI_API_KEY=tk_... npm run e2e                 # the shell needs it too, for setup and cleanup
```

To run against a cloud deployment instead, set `TENKI_E2E` and `TENKI_API_KEY`
on it and pass `CONVEX_URL=https://<deployment>.convex.cloud`.

### In CI

`e2e.yml` starts an anonymous local Convex backend, sets `TENKI_API_KEY` from
the repository secret and `TENKI_E2E=1`, and runs the suite. The nightly run
adds the slow checks.

Concurrency is grouped by event and ref, so a new push to a PR cancels that PR's
older run, while runs for different refs go ahead in parallel. The Test
workspace allows 5 active sandboxes and a run keeps at most 2 alive, so two
overlapping runs fit. Three or more at once can hit the limit.

The secret is a key for the **Test** Tenki workspace, which keeps CI separate
from anyone's personal workspace. When that workspace has no balance, every
create fails with `insufficient_credits`.

## Sweeper

`scripts/sweep.mjs` terminates `cvx-e2e:*` sandboxes older than an hour and
exits non-zero if it found any. A clean e2e run leaves none, so a failing sweep
means a cleanup bug in the suite.
