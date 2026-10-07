#!/usr/bin/env node
// Terminates e2e sandboxes and deletes e2e snapshots older than an hour; a
// successful e2e run leaves none, so any found here means a cleanup bug. Exits 1
// when it had to remove something.
import { TenkiSandbox } from "@tenkicloud/sandbox";
import { isLive } from "../dist/client/internal.js";

const MAX_AGE_MS = 60 * 60_000;
// Session ids are UUIDv7: the first 48 bits are the creation time in ms.
const createdAt = (id) => parseInt(id.replaceAll("-", "").slice(0, 12), 16);

const sdk = new TenkiSandbox();
const stale = (await sdk.list({}))
  .filter(isLive)
  .filter((s) => s.tags.some((t) => t.startsWith("cvx-e2e:")))
  .filter((s) => Date.now() - createdAt(s.id) > MAX_AGE_MS);

for (const s of stale) {
  console.log(`terminating ${s.id} (${s.state}, tags ${s.tags.join(",")})`);
  await s.close().catch((err) => console.log(`  failed: ${err}`));
}

const snapshots = (await sdk.listSnapshots())
  .filter((s) => s.name.startsWith("cvx-e2e-") && s.state !== "DELETING")
  .filter((s) => Date.now() - s.createdAt.getTime() > MAX_AGE_MS);
for (const s of snapshots) {
  console.log(`deleting snapshot ${s.id} (${s.name})`);
  await sdk
    .deleteSnapshot(s.id)
    .catch((err) => console.log(`  failed: ${err}`));
}
console.log(
  `swept ${stale.length} stale e2e sandbox(es), ${snapshots.length} snapshot(s)`,
);
process.exit(stale.length || snapshots.length ? 1 : 0);
