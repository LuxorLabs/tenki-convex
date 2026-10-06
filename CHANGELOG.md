# Changelog

## Unreleased

- Create, run commands in, and destroy Tenki sandboxes from Convex actions, with
  each sandbox's state in a Convex table your UI can subscribe to.
- Pause, resume, extend, snapshot and fork sandboxes.
- Start background processes and check on them, read and write files, and expose
  ports as public URLs.
- `reconcile` keeps rows in sync with sandboxes that reached their deadline.
- An empty Tenki workspace balance is reported as `insufficient_credits`.
- `create` resumes a paused sandbox, including one Tenki paused at its deadline;
  pass `resume: false` to get it as it is.
- `exec` caps output inside the sandbox, so a command that prints a lot can no
  longer exhaust the action's memory.
- Resuming a sandbox counts against `maxActiveSandboxes`.
- `fork` refuses a target that is still live, and lets Tenki delete its snapshot
  once nothing uses it. Restoring a snapshot records the snapshot's size rather
  than the `defaults`.
- `destroy` cancels a `create` still in flight.
- `readFile` throws `file_too_large` for files over 16 MiB (set `maxBytes` to
  change it), and `kill` can send `INT` and `HUP`.
- Errors that were reported as `internal` now have specific codes:
  `invalid_argument`, `snapshot_not_found`, `unavailable`, `timeout` and
  `terminated`.
