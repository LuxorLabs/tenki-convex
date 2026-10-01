/// <reference types="vite/client" />
import { test } from "vitest";
import { convexTest } from "convex-test";
import { componentsGeneric, defineSchema } from "convex/server";
import type { ComponentApi } from "../component/_generated/component.js";
import { register } from "../test.js";

export const modules = {
  ...import.meta.glob("./**/*.*s"),
  // convex-test resolves function paths relative to a `_generated` entry.
  "./_generated/api.js": async () => ({}),
};

export function initConvexTest() {
  const t = convexTest(defineSchema({}), modules);
  register(t);
  return t;
}

export const components = componentsGeneric() as unknown as {
  tenki: ComponentApi;
};

test("setup", () => {});
