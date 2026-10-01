import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const phaseValidator = v.union(
  v.literal("provisioning"),
  v.literal("ready"),
  v.literal("pausing"),
  v.literal("paused"),
  v.literal("resuming"),
  v.literal("terminated"),
  v.literal("error"),
);

export const remoteValidator = v.object({
  state: v.string(),
  timeoutAt: v.optional(v.number()),
  cpuCores: v.number(),
  memoryMb: v.number(),
  diskSizeGb: v.number(),
  sticky: v.boolean(),
});

export const errorValidator = v.object({
  code: v.string(),
  message: v.string(),
  at: v.number(),
});

export const previewValidator = v.object({
  port: v.number(),
  url: v.string(),
  expiresAt: v.optional(v.number()),
});

export default defineSchema({
  sandboxes: defineTable({
    ownerId: v.string(),
    key: v.string(),
    phase: phaseValidator,
    sessionId: v.optional(v.string()),
    // Creation lease: only the holder calls CreateSession for this (ownerId, key).
    claim: v.optional(v.object({ token: v.string(), expiresAt: v.number() })),
    remote: v.optional(remoteValidator),
    previews: v.optional(v.array(previewValidator)),
    lastError: v.optional(errorValidator),
    updatedAt: v.number(),
  })
    .index("by_owner_key", ["ownerId", "key"])
    .index("by_phase_updated", ["phase", "updatedAt"]),
  snapshots: defineTable({
    ownerId: v.string(),
    key: v.string(),
    sessionId: v.string(),
    snapshotId: v.string(),
    name: v.optional(v.string()),
  }).index("by_owner_key", ["ownerId", "key"]),
});
