# Changelog

## 0.1.1

- No changes to the component or its runtime dependencies.

## 0.1.0

- Create, run commands in, and destroy Tenki sandboxes from Convex actions, with
  each sandbox's state in a Convex table your UI can subscribe to.
- Pause, resume, extend, snapshot and fork sandboxes.
- Start background processes and check on them, read and write files, and expose
  ports as public URLs.
- `reconcile` keeps rows in sync with sandboxes that reached their deadline.
- An empty Tenki workspace balance is reported as `insufficient_credits`.
- `create` resumes a paused sandbox, including one Tenki paused at its deadline,
  which starts a new lifetime; pass `resume: false` to get it as it is.
- `exec` caps output per stream inside the sandbox (`maxOutputBytes`, 1 MiB by
  default); commands need `bash`, `head` and `cat` in the image.
- `maxActiveSandboxes` also covers resumes and forks.
- `fork` throws `already_exists` if the target exists, records the source's
  size, and its snapshot is deleted once nothing uses it.
- `destroy` cancels a `create` still in flight.
- `readFile` throws `file_too_large` above `maxBytes` (16 MiB by default).
- `kill` sends `TERM`, `KILL`, `INT` or `HUP`.
- Tags must be valid Tenki tags, and the `cvx:` prefix is reserved.
- Errors carry specific codes, including `invalid_argument`, `unavailable`,
  `snapshot_not_found`, `timeout` and `terminated`.
