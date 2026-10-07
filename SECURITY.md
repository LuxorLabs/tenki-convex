# Security policy

## Reporting a vulnerability

**Do not report security vulnerabilities through public issues, discussions or
pull requests.** A public report tells an attacker about the hole before a fix
exists.

Use
[GitHub's private vulnerability reporting](https://github.com/LuxorLabs/tenki-convex/security/advisories/new)
instead. It opens a private thread with the maintainers on this repository.

Tell us what you found, how to reproduce it, and what an attacker gets out of
it. If we act on a report, we will coordinate the disclosure with you.

## What is in scope

This repository: the Convex component (`src/component`), the `Tenki` client
(`src/client`), the example app in `example/`, and the CI workflows.

Two things are out of scope because they can't be fixed here, though we would
still like to hear about them: the Tenki platform itself (sandbox isolation, the
API, preview URLs), and Convex.

## What deserves a report

The component holds a Tenki API key and runs commands in sandboxes on behalf of
many owners, so the interesting failures are about the boundaries between those:

- The Tenki API key reaching somewhere it should not: a Convex table, a log
  line, an error returned to a client, a sandbox.
- One owner reaching another owner's sandbox, row, snapshot or process through
  the component, given an app that derives `ownerId` from `ctx.auth`.
- Input to `exec`, `spawn`, `processStatus` or `kill` that runs as shell code
  outside the command it was meant to be part of: a process id, signal, path or
  env value interpreted by the scripts the client runs in the guest.
- A way past `maxActiveSandboxes`.
- In the example app: calling the e2e harness without the deployment's admin
  key, or getting around the demo's limits (lifetime, size, egress, sandboxes
  per visitor).

## What is not a vulnerability

- Running arbitrary commands inside a sandbox you own. That is what a sandbox is
  for.
- A preview URL being reachable by anyone. `exposePort` URLs are public by
  design.
- An app passing client-supplied input as `ownerId`. `ownerId` is the only thing
  separating tenants, and the README says to derive it from `ctx.auth`.

## Supported versions

There are no long-term support branches. Whatever gets fixed goes out in the
next release of `@tenkicloud/convex`, and nothing is backported.
