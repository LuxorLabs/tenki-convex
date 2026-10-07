# Releasing

The repository is public and 0.1.0 is on npm (steps 1 to 4 under Going public
are done). A release reaches npm only after someone pushes a `v*` tag, a
reviewer approves the release run, and a maintainer of `@tenkicloud/convex`
approves the staged version on npm.

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
4. Publish the first version. Done: 0.1.0 was published on 2026-10-07 with a
   short-lived granular token stored as the `npm-publish` environment's
   `NPM_TOKEN` secret, since a trusted publisher can't be set up for a package
   that doesn't exist yet. The workflow no longer has that token path.
5. On npmjs.com, add a trusted publisher to `@tenkicloud/convex`: GitHub
   Actions, organization `LuxorLabs`, repository `tenki-convex`, workflow
   `npm-publish.yml`, environment `npm-publish`. Under its allowed actions,
   `npm stage publish` is always allowed; leave `npm publish` and dist-tags
   unchecked, since the workflow only stages. A new trusted publisher has to
   complete a publish within 2 days or it expires, so add it close to a release.
   Then delete the `NPM_TOKEN` secret and revoke the token. Finally, under the
   package's **Settings → Publishing access**, choose **Require two-factor
   authentication and disallow tokens**. Trusted publishing keeps working, and
   no token can publish the package.

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

Bump the version, tag it, push, approve the run, then approve the staged version
on npm:

```sh
npm version 0.1.1 --no-git-tag-version
git commit -am "@tenkicloud/convex 0.1.1"
git tag -a v0.1.1 -m "@tenkicloud/convex 0.1.1"
git push origin main --follow-tags
```

The tag must be annotated: `--follow-tags` doesn't push lightweight tags. The
workflow refuses a tag that doesn't match `package.json`, a tag that isn't on
`main`, and a version that is already on npm.

After a reviewer on the `npm-publish` environment approves the run, the publish
job stages the version with `npm stage publish`. Nothing is live until a
maintainer of `@tenkicloud/convex` approves it with 2FA. The run summary shows
the stage id:

```sh
npm stage approve <stage-id>   # or Staged Packages on npmjs.com
npm stage reject <stage-id>    # to drop it instead
npm stage list @tenkicloud/convex
```

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
