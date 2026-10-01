import { cronJobs } from "convex/server";
import { internal } from "./_generated/api.js";

const crons = cronJobs();
crons.interval(
  "reconcile tenki sandboxes",
  { minutes: 5 },
  internal.workspaceActions.reconcile,
);

export default crons;
