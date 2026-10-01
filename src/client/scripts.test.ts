// @vitest-environment node
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  KILL_SCRIPT,
  parseStatus,
  SPAWN_SCRIPT,
  STATUS_SCRIPT,
} from "./internal.js";

const hasSetsid = spawnSync("sh", ["-c", "command -v setsid"]).status === 0;

test.skipIf(!hasSetsid)(
  "spawn, status and kill scripts work under a real bash",
  async () => {
    const home = mkdtempSync(join(tmpdir(), "tenki-cvx-"));
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

    run(SPAWN_SCRIPT, {
      TENKI_CVX_ID: "aaaaaaaa",
      TENKI_CVX_CMD: 'echo "$HOME" && exit 7',
    });
    await settle();
    expect(status("aaaaaaaa")).toEqual({
      state: "exited",
      exitCode: 7,
      output: `${home}\n`,
      outputTruncated: false,
    });

    run(SPAWN_SCRIPT, {
      TENKI_CVX_ID: "bbbbbbbb",
      TENKI_CVX_CMD: "echo started; sleep 30",
    });
    await settle();
    expect(status("bbbbbbbb")).toMatchObject({
      state: "running",
      output: "started\n",
    });
    expect(
      run(KILL_SCRIPT, {
        TENKI_CVX_ID: "bbbbbbbb",
        TENKI_CVX_SIGNAL: "TERM",
      }).trim(),
    ).toBe("signaled");
    await settle();
    expect(status("bbbbbbbb")).toMatchObject({
      state: "killed",
      signal: "TERM",
    });

    expect(status("cccccccc")).toMatchObject({ state: "missing" });
  },
);
