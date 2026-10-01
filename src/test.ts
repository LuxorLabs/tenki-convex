/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import type { GenericSchema, SchemaDefinition } from "convex/server";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/**
 * Register the component with a `convex-test` instance.
 * @param name - The name the app installed the component under in convex.config.ts.
 */
export function register(
  t: TestConvex<SchemaDefinition<GenericSchema, boolean>>,
  name: string = "tenki",
) {
  t.registerComponent(name, schema, modules);
}
export default { register, schema, modules };
