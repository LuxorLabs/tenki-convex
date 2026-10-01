/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as crons from "../crons.js";
import type * as demo from "../demo.js";
import type * as demoQueries from "../demoQueries.js";
import type * as e2e from "../e2e.js";
import type * as e2eGate from "../e2eGate.js";
import type * as e2eQueries from "../e2eQueries.js";
import type * as http from "../http.js";
import type * as maintenance from "../maintenance.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  crons: typeof crons;
  demo: typeof demo;
  demoQueries: typeof demoQueries;
  e2e: typeof e2e;
  e2eGate: typeof e2eGate;
  e2eQueries: typeof e2eQueries;
  http: typeof http;
  maintenance: typeof maintenance;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  tenki: import("@tenkicloud/convex/_generated/component.js").ComponentApi<"tenki">;
};
