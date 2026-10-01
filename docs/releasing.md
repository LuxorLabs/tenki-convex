# Releasing

The repository is private and `package.json` has `"private": true`, so nothing
can be published by accident. The steps below take it public. None of them have
been done yet.

## Before going public

1. Top up the **Test** Tenki workspace. CI's e2e suite fails with
   `insufficient_credits` while its balance is empty.
2. Make sure CI is green: `Test and lint`, and `E2E` including a nightly run
   with the slow checks.
3. Decide which Convex team owns the demo and CI deployments.
4. Re-read the README as a first-time user would.

## Going public

1. Make `LuxorLabs/tenki-convex` public.
2. Remove `"private": true` from `package.json`.
3. Publish to npm under the `@tenkicloud` scope (same scope as
   `@tenkicloud/sandbox`):

   ```sh
   npm ci && npm run build:clean && npm test && npm run lint && npm run typecheck && npm run pack:check
   npm version 0.1.0 --no-git-tag-version   # or the version you want
   npm publish --access public
   git tag v0.1.0 && git push --follow-tags
   ```

4. Run Convex's
   [preflight check](https://www.convex.dev/components/submit/check) on the
   public repo URL. It needs a URL it can fetch, so it can't run while the repo
   is private. It checks:
   - `defineComponent` in `convex.config.ts`
   - object-style function syntax
   - argument and return validators, and `v.null()` for void returns
   - auth patterns

   Every component function already has both validators.

5. Deploy the demo (see [demo.md](demo.md)) so the listing can link to it.

## Submitting to the Components Directory

Not done yet; this needs a go-ahead.

1. Submit the repo at <https://www.convex.dev/components/submit>. Submitting
   commits us to maintaining the component.
2. Once listed, keep `@tenkicloud/sandbox` current. Renovate opens a separate PR
   for each SDK release, and e2e must pass before anyone merges it.
3. Run the preflight check before each release.

## Known platform issues

These are outside this repo but affect users:

- **SDK type declarations:** `@tenkicloud/sandbox`'s published types import
  `ws`, but `@types/ws` is only a dev dependency of the SDK. Projects with
  `skipLibCheck: false` get TS7016. Convex's default tsconfig skips lib checks,
  so most users won't see it. `pack-check.sh` installs `@types/ws` to work
  around it.
- **`/tmp` across pause:** the SDK README says `/tmp` is cleared across a pause,
  but in prod (October 2026) a file in `/tmp` survived pause and resume.
- **Slow pause:** pausing a 2 vCPU / 4 GB sandbox took about 50s in prod, so the
  component's blocking `pause` takes that long too.
