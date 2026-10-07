# Releasing

The repository is private and `package.json` has `"private": true`, so nothing
can be published by accident. The steps below take it public.

## Before going public

1. Top up the **Test** Tenki workspace. CI's e2e suite fails with
   `insufficient_credits` while its balance is empty.
2. Make sure CI is green: `Test and lint`, and `E2E` including a nightly run
   with the slow checks.
3. Decide which Convex team owns the demo and CI deployments.
4. Re-read the README as a first-time user would.

## Going public

1. Make `LuxorLabs/tenki-convex` public. Publishing works from a private repo,
   but npm only attaches provenance to packages built from public ones.
2. Remove `"private": true` from `package.json`. The release workflow refuses to
   publish while it is set.
3. Set up the `npm-publish` environment and protect release tags. npm's trusted
   publisher matches the repository, workflow file and environment but not the
   ref, so these settings are what tie publishing to release tags:
   - **Settings → Environments → `npm-publish`:** add required reviewers and
     turn on **Prevent self-review**, so whoever pushes a tag can't approve its
     publish. Under **Deployment branches and tags**, choose **Selected branches
     and tags** with one tag rule, `v*`, so a branch that edits the workflow
     can't use the environment.
   - **Settings → Rules → Rulesets:** add a tag ruleset for `v*` with **Restrict
     creations**, **Restrict updates** and **Restrict deletions**, and only
     release maintainers on the bypass list.
4. Publish the first version. `.github/workflows/npm-publish.yml` publishes when
   a `v*` tag matching `package.json`'s version and pointing at a commit on
   `main` is pushed, after build, tests, typecheck, lint, the pack check and a
   production dependency audit, and after one of the `npm-publish` environment's
   reviewers approves the run. A trusted publisher can't be set up for a package
   that doesn't exist yet, so the first version uses a token:
   - Create an npm granular access token that can publish to `@tenkicloud`, with
     the shortest expiration that covers the first release, and save it as
     `NPM_TOKEN` in the `npm-publish` environment's secrets, not as a repository
     secret. Only the approved publish job can read an environment secret.
   - Run **Release** from the Actions tab to see every gate pass; a manual run
     is always a dry run. Then tag and push:

     ```sh
     git tag -a v0.1.0 -m "@tenkicloud/convex 0.1.0" && git push origin v0.1.0
     ```

   - Approve the run.
5. On npmjs.com, add a trusted publisher to `@tenkicloud/convex`: GitHub
   Actions, organization `LuxorLabs`, repository `tenki-convex`, workflow
   `npm-publish.yml`, environment `npm-publish`. Then delete the `NPM_TOKEN`
   secret and revoke the token; later releases publish without one. Finally,
   under the package's **Settings → Publishing access**, choose **Require
   two-factor authentication and disallow tokens**. Trusted publishing keeps
   working, and no token can publish the package.

6. Run Convex's
   [preflight check](https://www.convex.dev/components/submit/check) on the
   public repo URL. It needs a URL it can fetch, so it can't run while the repo
   is private. It checks:
   - `defineComponent` in `convex.config.ts`
   - object-style function syntax
   - argument and return validators, and `v.null()` for void returns
   - auth patterns

   Every component function already has both validators.

7. Deploy the demo (see [demo.md](demo.md)) so the listing can link to it.

## Later releases

Bump the version, tag it, push, and approve the run:

```sh
npm version 0.1.1 --no-git-tag-version
git commit -am "@tenkicloud/convex 0.1.1"
git tag -a v0.1.1 -m "@tenkicloud/convex 0.1.1"
git push origin main --follow-tags
```

The tag must be annotated: `--follow-tags` doesn't push lightweight tags. The
workflow refuses a tag that doesn't match `package.json`, a tag that isn't on
`main`, and a version that is already on npm.

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
