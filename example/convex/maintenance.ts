"use node";
import { Tenki } from "@tenkicloud/convex";
import { internalAction } from "./_generated/server.js";
import { components } from "./_generated/api.js";

const tenki = new Tenki(components.tenki);

export const reconcile = internalAction({
  args: {},
  handler: async (ctx) => await tenki.reconcile(ctx),
});
