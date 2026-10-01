# Demo app

`example/` is a single-page React app on Convex:

- Each visitor is signed in anonymously with Convex Auth and gets a sandbox.
- They can run shell commands in it and start a web server that's reachable at a
  public preview URL.
- They can pause, resume, fork and destroy it.

The sandbox card re-renders from a Convex subscription, so phase changes show up
without polling.

| File                                         | Role                                                     |
| -------------------------------------------- | -------------------------------------------------------- |
| `example/convex/demo.ts`                     | Public actions. `ownerId` comes from the signed-in user. |
| `example/convex/demoQueries.ts`              | `mine`: the visitor's sandboxes, live                    |
| `example/convex/maintenance.ts` + `crons.ts` | `reconcile` every 5 minutes                              |
| `example/convex/auth*.ts`, `http.ts`         | Convex Auth with the anonymous provider                  |
| `example/convex/e2e*.ts`                     | The e2e harness, disabled unless `TENKI_E2E=1`           |
| `example/src/`                               | The React page                                           |

## Safeguards

The demo is meant to be public, so `demo.ts` limits what a visitor can do:

- **Lifetime:** every sandbox lasts 10 minutes.
- **Size:** 2 vCPU and 2 GB.
- **Egress:** only `pypi.org`, `files.pythonhosted.org` and `registry.npmjs.org`
  are reachable.
- **Sandboxes per visitor:** one main sandbox and one fork.
- **Global cap:** a new sandbox is refused once `DEMO_MAX_LIVE_SANDBOXES` are
  live across all visitors (default 10).
- **Commands:** at most 2,000 characters, a 60-second timeout and 64 KiB of
  output.

Point the demo at its own Tenki workspace with a credit cap; the workspace's
concurrency limit is the final backstop. Preview URLs are public.

## Running it locally

```sh
npm install && npm run build
CONVEX_AGENT_MODE=anonymous npx convex dev       # leave running
npx convex env set TENKI_API_KEY                  # paste the key
node scripts/setup-demo-auth.mjs                  # Convex Auth keys + SITE_URL=http://localhost:5173
VITE_CONVEX_URL=http://127.0.0.1:3210 npm run dev:frontend
```

Then open http://localhost:5173.

## Deploying it

1. Deploy the backend to a dedicated Convex project: `npx convex deploy`.
2. On that deployment, set:
   - `TENKI_API_KEY`
   - `DEMO_MAX_LIVE_SANDBOXES`
   - the Convex Auth keys, with
     `node scripts/setup-demo-auth.mjs https://<frontend-host>`
3. Do not set `TENKI_E2E`.
4. Build the frontend with `VITE_CONVEX_URL` set to the deployment's URL
   (`cd example && npx vite build`), and host `example/dist` on any static host.
