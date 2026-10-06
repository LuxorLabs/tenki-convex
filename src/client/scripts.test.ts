// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  cappedArgv,
  KILL_SCRIPT,
  newProcessId,
  parseStatus,
  SPAWN_SCRIPT,
  STATUS_SCRIPT,
} from "./internal.js";

// The scripts rely on setsid and /proc, so they only run on Linux.
const isLinux =
  process.platform === "linux" &&
  spawnSync("sh", ["-c", "command -v setsid"]).status === 0;

test.skipIf(!isLinux)(
  "spawn, status and kill scripts work under a real bash",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "tenki-cvx-"));
    const procHome = execFileSync("sh", [
      "-c",
      'getent passwd "$(id -u)" | cut -d: -f6',
    ])
      .toString()
      .trim();
    const run = (script: string, env: Record<string, string>) =>
      execFileSync("bash", ["-c", script], {
        env: { PATH: process.env.PATH, HOME: home, ...env },
      }).toString();
    const status = (id: string) =>
      parseStatus(
        run(STATUS_SCRIPT, { TENKI_CVX_ID: id, TENKI_CVX_TAIL: "1000" }),
        1000,
      );
    const settle = () => new Promise((r) => setTimeout(r, 300));

    const quick = newProcessId();
    run(SPAWN_SCRIPT, {
      TENKI_CVX_ID: quick,
      TENKI_CVX_CMD: 'echo "$HOME" && exit 7',
    });
    await settle();
    expect(status(quick)).toEqual({
      state: "exited",
      exitCode: 7,
      output: `${home}\n`,
      outputTruncated: false,
    });

    const server = newProcessId();
    run(SPAWN_SCRIPT, {
      TENKI_CVX_ID: server,
      TENKI_CVX_CMD: "echo started; sleep 30",
    });
    await settle();
    expect(status(server)).toMatchObject({
      state: "running",
      output: "started\n",
    });
    expect(
      run(KILL_SCRIPT, {
        TENKI_CVX_ID: server,
        TENKI_CVX_SIGNAL: "TERM",
      }).trim(),
    ).toBe("signaled");
    await settle();
    expect(status(server)).toMatchObject({ state: "killed", signal: "TERM" });

    expect(status(newProcessId())).toMatchObject({ state: "missing" });

    // A HOME override in the caller's env must not move the process directory.
    const moved = newProcessId();
    run(SPAWN_SCRIPT, {
      TENKI_CVX_ID: moved,
      TENKI_CVX_CMD: "sleep 30",
      HOME: "/nonexistent",
    });
    await settle();
    expect(status(moved)).toMatchObject({ state: "running" });

    // A pid whose start time no longer matches belongs to someone else now.
    writeFileSync(join(procHome, ".tenki-convex/proc", moved, "start"), "1\n");
    expect(status(moved)).toMatchObject({ state: "lost" });
    expect(
      run(KILL_SCRIPT, {
        TENKI_CVX_ID: moved,
        TENKI_CVX_SIGNAL: "TERM",
      }).trim(),
    ).toBe("gone");
    execFileSync("bash", [
      "-c",
      `kill -- -$(cat "${join(procHome, ".tenki-convex/proc", moved, "pid")}")`,
    ]);

    // Children the command leaves behind keep it running, and kill reaches them.
    const daemon = newProcessId();
    run(SPAWN_SCRIPT, {
      TENKI_CVX_ID: daemon,
      TENKI_CVX_CMD: "sleep 30 & exit 0",
    });
    await settle();
    expect(status(daemon)).toMatchObject({ state: "running" });
    expect(
      run(KILL_SCRIPT, {
        TENKI_CVX_ID: daemon,
        TENKI_CVX_SIGNAL: "TERM",
      }).trim(),
    ).toBe("signaled");
    await settle();
    expect(status(daemon)).toMatchObject({ state: "exited", exitCode: 0 });

    // INT and HUP reach the process where env can restore their handlers.
    const canReset =
      spawnSync("env", ["--default-signal=INT", "true"]).status === 0;
    for (const signal of canReset ? ["INT", "HUP"] : []) {
      const id = newProcessId();
      run(SPAWN_SCRIPT, { TENKI_CVX_ID: id, TENKI_CVX_CMD: "sleep 30" });
      await settle();
      expect(
        run(KILL_SCRIPT, { TENKI_CVX_ID: id, TENKI_CVX_SIGNAL: signal }).trim(),
      ).toBe("signaled");
      await settle();
      expect(status(id)).toMatchObject({ state: "killed", signal });
    }
  },
);

test("exec output is capped per stream inside the sandbox, keeping the exit code", () => {
  const [bash, ...args] = cappedArgv(
    ["bash", "-c", "head -c 100000 /dev/zero; echo oops >&2; exit 3"],
    5,
  );
  const r = spawnSync(bash, args);
  expect(r.status).toBe(3);
  expect(r.stdout.byteLength).toBe(5);
  expect(r.stderr.toString()).toBe("oops\n");
  const argv = spawnSync(
    bash,
    cappedArgv(["printf", "%s", "a b"], 100).slice(1),
  );
  expect(argv.stdout.toString()).toBe("a b");
});

test("an exit file caught mid-write reads as still running", () => {
  expect(parseStatus("exited  12\nout", 100)).toMatchObject({
    state: "running",
    output: "out",
  });
  expect(parseStatus("exited 0 3\nok\n", 100)).toMatchObject({
    state: "exited",
    exitCode: 0,
  });
});
