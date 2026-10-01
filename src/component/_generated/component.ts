/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    sandboxes: {
      claim: FunctionReference<
        "mutation",
        "internal",
        { key: string; leaseMs: number; ownerId: string; token: string },
        {
          claimed: boolean;
          sandbox: {
            _creationTime: number;
            _id: string;
            claim?: { expiresAt: number; token: string };
            key: string;
            lastError?: { at: number; code: string; message: string };
            ownerId: string;
            phase:
              | "provisioning"
              | "ready"
              | "pausing"
              | "paused"
              | "resuming"
              | "terminated"
              | "error";
            previews?: Array<{ expiresAt?: number; port: number; url: string }>;
            remote?: {
              cpuCores: number;
              diskSizeGb: number;
              memoryMb: number;
              state: string;
              sticky: boolean;
              timeoutAt?: number;
            };
            sessionId?: string;
            updatedAt: number;
          };
        },
        Name
      >;
      complete: FunctionReference<
        "mutation",
        "internal",
        {
          key: string;
          ownerId: string;
          phase:
            | "provisioning"
            | "ready"
            | "pausing"
            | "paused"
            | "resuming"
            | "terminated"
            | "error";
          remote: {
            cpuCores: number;
            diskSizeGb: number;
            memoryMb: number;
            state: string;
            sticky: boolean;
            timeoutAt?: number;
          };
          sessionId: string;
          token: string;
        },
        {
          accepted: boolean;
          sandbox: {
            _creationTime: number;
            _id: string;
            claim?: { expiresAt: number; token: string };
            key: string;
            lastError?: { at: number; code: string; message: string };
            ownerId: string;
            phase:
              | "provisioning"
              | "ready"
              | "pausing"
              | "paused"
              | "resuming"
              | "terminated"
              | "error";
            previews?: Array<{ expiresAt?: number; port: number; url: string }>;
            remote?: {
              cpuCores: number;
              diskSizeGb: number;
              memoryMb: number;
              state: string;
              sticky: boolean;
              timeoutAt?: number;
            };
            sessionId?: string;
            updatedAt: number;
          } | null;
        },
        Name
      >;
      fail: FunctionReference<
        "mutation",
        "internal",
        {
          code: string;
          key: string;
          message: string;
          ownerId: string;
          token: string;
        },
        null,
        Name
      >;
      get: FunctionReference<
        "query",
        "internal",
        { key: string; ownerId: string },
        {
          _creationTime: number;
          _id: string;
          claim?: { expiresAt: number; token: string };
          key: string;
          lastError?: { at: number; code: string; message: string };
          ownerId: string;
          phase:
            | "provisioning"
            | "ready"
            | "pausing"
            | "paused"
            | "resuming"
            | "terminated"
            | "error";
          previews?: Array<{ expiresAt?: number; port: number; url: string }>;
          remote?: {
            cpuCores: number;
            diskSizeGb: number;
            memoryMb: number;
            state: string;
            sticky: boolean;
            timeoutAt?: number;
          };
          sessionId?: string;
          updatedAt: number;
        } | null,
        Name
      >;
      list: FunctionReference<
        "query",
        "internal",
        { limit?: number; ownerId: string },
        Array<{
          _creationTime: number;
          _id: string;
          claim?: { expiresAt: number; token: string };
          key: string;
          lastError?: { at: number; code: string; message: string };
          ownerId: string;
          phase:
            | "provisioning"
            | "ready"
            | "pausing"
            | "paused"
            | "resuming"
            | "terminated"
            | "error";
          previews?: Array<{ expiresAt?: number; port: number; url: string }>;
          remote?: {
            cpuCores: number;
            diskSizeGb: number;
            memoryMb: number;
            state: string;
            sticky: boolean;
            timeoutAt?: number;
          };
          sessionId?: string;
          updatedAt: number;
        }>,
        Name
      >;
      listSnapshots: FunctionReference<
        "query",
        "internal",
        { key: string; limit?: number; ownerId: string },
        Array<{
          _creationTime: number;
          _id: string;
          key: string;
          name?: string;
          ownerId: string;
          sessionId: string;
          snapshotId: string;
        }>,
        Name
      >;
      recordSnapshot: FunctionReference<
        "mutation",
        "internal",
        {
          key: string;
          name?: string;
          ownerId: string;
          sessionId: string;
          snapshotId: string;
        },
        {
          _creationTime: number;
          _id: string;
          key: string;
          name?: string;
          ownerId: string;
          sessionId: string;
          snapshotId: string;
        },
        Name
      >;
      setPreview: FunctionReference<
        "mutation",
        "internal",
        {
          key: string;
          ownerId: string;
          preview: { expiresAt?: number; port: number; url: string };
          sessionId: string;
        },
        {
          _creationTime: number;
          _id: string;
          claim?: { expiresAt: number; token: string };
          key: string;
          lastError?: { at: number; code: string; message: string };
          ownerId: string;
          phase:
            | "provisioning"
            | "ready"
            | "pausing"
            | "paused"
            | "resuming"
            | "terminated"
            | "error";
          previews?: Array<{ expiresAt?: number; port: number; url: string }>;
          remote?: {
            cpuCores: number;
            diskSizeGb: number;
            memoryMb: number;
            state: string;
            sticky: boolean;
            timeoutAt?: number;
          };
          sessionId?: string;
          updatedAt: number;
        } | null,
        Name
      >;
      stale: FunctionReference<
        "query",
        "internal",
        { limit: number },
        Array<{
          _creationTime: number;
          _id: string;
          claim?: { expiresAt: number; token: string };
          key: string;
          lastError?: { at: number; code: string; message: string };
          ownerId: string;
          phase:
            | "provisioning"
            | "ready"
            | "pausing"
            | "paused"
            | "resuming"
            | "terminated"
            | "error";
          previews?: Array<{ expiresAt?: number; port: number; url: string }>;
          remote?: {
            cpuCores: number;
            diskSizeGb: number;
            memoryMb: number;
            state: string;
            sticky: boolean;
            timeoutAt?: number;
          };
          sessionId?: string;
          updatedAt: number;
        }>,
        Name
      >;
      sync: FunctionReference<
        "mutation",
        "internal",
        {
          key: string;
          ownerId: string;
          phase:
            | "provisioning"
            | "ready"
            | "pausing"
            | "paused"
            | "resuming"
            | "terminated"
            | "error";
          remote?: {
            cpuCores: number;
            diskSizeGb: number;
            memoryMb: number;
            state: string;
            sticky: boolean;
            timeoutAt?: number;
          };
          sessionId: string;
        },
        {
          _creationTime: number;
          _id: string;
          claim?: { expiresAt: number; token: string };
          key: string;
          lastError?: { at: number; code: string; message: string };
          ownerId: string;
          phase:
            | "provisioning"
            | "ready"
            | "pausing"
            | "paused"
            | "resuming"
            | "terminated"
            | "error";
          previews?: Array<{ expiresAt?: number; port: number; url: string }>;
          remote?: {
            cpuCores: number;
            diskSizeGb: number;
            memoryMb: number;
            state: string;
            sticky: boolean;
            timeoutAt?: number;
          };
          sessionId?: string;
          updatedAt: number;
        } | null,
        Name
      >;
    };
  };
