# Releasing

`.github/workflows/npm-publish.yml` publishes `@tenkicloud/convex` from a `v*`
tag. It stages the version through npm trusted publishing, and nothing is live
until a maintainer of `@tenkicloud/convex` approves it on npm with 2FA.

## Cutting a release

Bump the version, tag it, push, then approve the staged version on npm:

```sh
npm version 0.1.1 --no-git-tag-version
git commit -am "@tenkicloud/convex 0.1.1"
git tag -a v0.1.1 -m "@tenkicloud/convex 0.1.1"
git push origin main --follow-tags
```

The tag must be annotated: `--follow-tags` doesn't push lightweight tags. The
workflow refuses a tag that doesn't match `package.json`, a tag that isn't on
`main`, and a version that is already on npm.

The publish job stages the version with `npm stage publish`. Nothing is live
until a maintainer of `@tenkicloud/convex` approves it with 2FA. The run summary
shows the stage id:

```sh
npm stage approve <stage-id>   # or Staged Packages on npmjs.com
npm stage reject <stage-id>    # to drop it instead
npm stage list @tenkicloud/convex
```

## Settings releases rely on

npm's trusted publisher matches the repository, workflow file and environment
but not the ref, so these settings are what tie publishing to release tags:

- **npmjs.com, the package's trusted publisher:** GitHub Actions, organization
  `LuxorLabs`, repository `tenki-convex`, workflow `npm-publish.yml`,
  environment `npm-publish`. `npm stage publish` is always allowed; leave
  `npm publish` and dist-tags unchecked, since the workflow only stages. A new
  trusted publisher has to complete a publish within 2 days or it expires, so
  recreate one close to a release.
- **npmjs.com, the package's Settings → Publishing access:** **Require
  two-factor authentication and disallow tokens**. Trusted publishing keeps
  working, and no token can publish the package.
- **GitHub Settings → Environments → `npm-publish`:** under **Deployment
  branches and tags**, choose **Selected branches and tags** with one tag rule,
  `v*`, so a branch that edits the workflow can't use the environment. It has no
  required reviewers: the trusted publisher only stages, and the 2FA approve on
  npm is the human check. If the trusted publisher ever allows `npm publish`,
  add reviewers back.
- **GitHub Settings → Rules → Rulesets:** a tag ruleset for `v*` with **Restrict
  creations**, **Restrict updates** and **Restrict deletions**, and only release
  maintainers on the bypass list.

## Submitting to the Components Directory

Not done yet; this needs a go-ahead.

1. Run Convex's
   [preflight check](https://www.convex.dev/components/submit/check) on the repo
   URL. It checks:
   - `defineComponent` in `convex.config.ts`
   - object-style function syntax
   - argument and return validators, and `v.null()` for void returns
   - auth patterns

   Every component function already has both validators.

2. Decide which Convex team owns the demo, and deploy it there (see
   [demo.md](demo.md)) so the listing can link to it.
3. Submit the repo at <https://www.convex.dev/components/submit>. Submitting
   commits us to maintaining the component.
4. Once listed, keep `@tenkicloud/sandbox` current. Renovate opens a separate PR
   for each SDK release, and e2e must pass before anyone merges it.
5. Run the preflight check before each release.

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
