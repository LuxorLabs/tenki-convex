#!/usr/bin/env node
// Rebuilds the component once, then again on every change under src/ or a
// tsconfig: `node --watch-path` in the dev:build script reruns this file.
import { execFileSync } from "node:child_process";

execFileSync("npm", ["run", "build:codegen"], { stdio: "inherit" });
