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
client: closed sessions list as `TERMINATING`, `pauseAsync` returns before the
session is `PAUSED`, and it can make `get` miss once or `resume` fail as
`unavailable`.

`src/client/scripts.test.ts` runs the real background-process scripts under
`bash`. They need `setsid` and `/proc`, so that test is skipped on macOS and
runs on Linux CI. The `exec` output cap test runs everywhere.

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
- extend, pause/resume, kill, fork (and fork into a live target), reconcile, and
  destroy with key reuse
- an `exec` that prints 200 MB, capped in the sandbox, and one that times out

With `E2E_SLOW=1` it also lets a 60-second sandbox reach its real deadline,
checks that `reconcile` catches the row up, and that `create` brings it back.
This adds two to three minutes.

Every sandbox the run creates is tagged `cvx-e2e:<run>` and terminated at the
end, and the fork's snapshot (named `cvx-e2e-<run>`) is deleted; the run fails
if any remain. Scenarios destroy what they create, so at most two sandboxes are
alive at once.

The harness takes `ownerId` from its caller, so its functions are internal and
the script calls them with the deployment's admin key: `CONVEX_ADMIN_KEY`, or
the key a local backend keeps in `.convex/local/default/config.json`. They also
refuse to run unless `TENKI_E2E=1` is set on the deployment. Never set it on a
deployment that serves the demo.

### Running locally

```sh
npm run build
CONVEX_AGENT_MODE=anonymous npx convex dev      # local backend, leave running
npx convex env set TENKI_API_KEY                 # paste the key; stdin keeps it out of history
npx convex env set TENKI_E2E 1
TENKI_API_KEY=tk_... npm run e2e                 # the shell needs it too, for setup and cleanup
```

To run against a cloud deployment instead, set `TENKI_E2E` and `TENKI_API_KEY`
on it and pass `CONVEX_URL=https://<deployment>.convex.cloud` and its
`CONVEX_ADMIN_KEY`.

### In CI

`e2e.yml` starts an anonymous local Convex backend, sets `TENKI_API_KEY` from
the repository secret and `TENKI_E2E=1`, and runs the suite. The nightly run
adds the slow checks. Only the steps that call Tenki get the key; installing and
building never see it.

Pull requests from forks skip the suite, since GitHub doesn't give them
repository secrets. Don't switch the trigger to `pull_request_target` to get
around that: it would run the fork's code with the key. To test a fork's change,
push it to a branch in this repository.

Concurrency is grouped by event and ref, so a new push to a PR cancels that PR's
older run, while runs for different refs go ahead in parallel. The Test
workspace allows 5 active sandboxes and a run keeps at most 2 alive, so two
overlapping runs fit. Three or more at once can hit the limit.

The secret is a key for the **Test** Tenki workspace, which keeps CI separate
from anyone's personal workspace. When that workspace has no balance, every
create fails with `insufficient_credits`.

## Sweeper

`scripts/sweep.mjs` terminates `cvx-e2e:*` sandboxes and deletes `cvx-e2e-*`
snapshots older than an hour, and exits non-zero if it found any. A clean e2e
run leaves none, so a failing sweep means a cleanup bug in the suite.
