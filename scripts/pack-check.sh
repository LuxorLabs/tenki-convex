#!/usr/bin/env bash
# Installs the packed tarball into a fresh project and type-checks and imports
# it the way a customer would, so broken exports fail before a release.
set -euo pipefail
root=$(pwd)
tarball="$root/$(npm pack --silent | tail -1)"
trap 'rm -f "$tarball"' EXIT
dir=$(mktemp -d)
cd "$dir"
cat > package.json <<'JSON'
{ "name": "pack-check", "private": true, "type": "module" }
JSON
# @types/ws: @tenkicloud/sandbox's published types import "ws" without depending on its types.
npm install --silent --no-fund --no-audit "$tarball" convex typescript @types/node @types/ws
mkdir -p convex
cat > convex/convex.config.ts <<'TS'
import { defineApp } from "convex/server";
import tenki from "@tenkicloud/convex/convex.config.js";

const app = defineApp();
app.use(tenki);
export default app;
TS
cat > convex/usage.ts <<'TS'
import { Tenki, type ExecResult, type ProcessStatus } from "@tenkicloud/convex";
import type { ComponentApi } from "@tenkicloud/convex/_generated/component.js";

declare const component: ComponentApi;
const tenki = new Tenki(component, { defaults: { cpuCores: 2 } });
export type Checks = [ExecResult, ProcessStatus, Awaited<ReturnType<typeof tenki.create>>];
TS
cat > tsconfig.json <<'JSON'
{
  "compilerOptions": {
    "strict": true,
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "skipLibCheck": false,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["convex"]
}
JSON
npx tsc
node -e 'const m = await import("@tenkicloud/convex"); if (typeof m.Tenki !== "function") process.exit(1); await import("@tenkicloud/convex/convex.config.js");' --input-type=module
echo "pack check passed: $(basename "$tarball")"
