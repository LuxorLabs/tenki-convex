// @vitest-environment node
import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const constructed = vi.hoisted(() => [] as unknown[]);
vi.mock("@tenkicloud/sandbox", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  TenkiSandbox: class {
    constructor(options: unknown) {
      constructed.push(options);
    }
  },
}));

const { Tenki } = await import("./index.js");
const { components } = await import("./setup.test.js");

const KEYS = [
  "LUXOR_API_KEY",
  "TENKI_API_KEY",
  "LUXOR_API_URL",
  "TENKI_API_URL",
];

function sdkOptions(options = {}) {
  const tenki = new Tenki(components.tenki, options) as unknown as {
    client(): unknown;
  };
  tenki.client();
  return constructed.at(-1);
}

beforeEach(() => {
  constructed.length = 0;
  for (const key of KEYS) vi.stubEnv(key, undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("SDK credentials from env", () => {
  test("LUXOR_API_KEY and LUXOR_API_URL win over TENKI_*", () => {
    vi.stubEnv("LUXOR_API_KEY", "lx_new");
    vi.stubEnv("TENKI_API_KEY", "tk_legacy");
    vi.stubEnv("LUXOR_API_URL", "https://api.luxor.test");
    vi.stubEnv("TENKI_API_URL", "https://api.tenki.test");
    expect(sdkOptions()).toEqual({
      apiKey: "lx_new",
      baseUrl: "https://api.luxor.test",
    });
  });

  test("falls back to TENKI_* when LUXOR_* is unset", () => {
    vi.stubEnv("TENKI_API_KEY", "tk_legacy");
    expect(sdkOptions()).toEqual({ apiKey: "tk_legacy", baseUrl: undefined });
  });

  test("explicit options win over env", () => {
    vi.stubEnv("LUXOR_API_KEY", "lx_new");
    expect(sdkOptions({ apiKey: "tk_explicit", baseUrl: "https://x" })).toEqual(
      { apiKey: "tk_explicit", baseUrl: "https://x" },
    );
  });

  test("missing key names LUXOR_API_KEY first", () => {
    let err: unknown;
    try {
      sdkOptions();
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConvexError);
    const { code, message } = (
      err as ConvexError<{ code: string; message: string }>
    ).data;
    expect(code).toBe("unauthenticated");
    expect(message.indexOf("LUXOR_API_KEY")).toBeLessThan(
      message.indexOf("TENKI_API_KEY"),
    );
    expect(message.indexOf("LUXOR_API_KEY")).toBeGreaterThanOrEqual(0);
  });

  test.each(["lx_new", "tk_new", " lx_padded "])(
    "LUXOR_API_KEY %j is used",
    (key) => {
      vi.stubEnv("LUXOR_API_KEY", key);
      vi.stubEnv("TENKI_API_KEY", "tk_legacy");
      expect(sdkOptions()).toEqual({ apiKey: key.trim(), baseUrl: undefined });
    },
  );

  test("LUXOR_API_KEY without an lx_ or tk_ prefix falls through to TENKI_API_KEY", () => {
    vi.stubEnv("LUXOR_API_KEY", "pool-key-123");
    vi.stubEnv("TENKI_API_KEY", "tk_legacy");
    expect(sdkOptions()).toEqual({ apiKey: "tk_legacy", baseUrl: undefined });
  });

  test("LUXOR_API_KEY without an lx_ or tk_ prefix alone counts as missing", () => {
    vi.stubEnv("LUXOR_API_KEY", "pool-key-123");
    expect(() => sdkOptions()).toThrow(ConvexError);
    expect(constructed).toHaveLength(0);
  });

  test("the prefix check does not apply to TENKI_API_KEY or an explicit apiKey", () => {
    vi.stubEnv("TENKI_API_KEY", "legacy-key");
    expect(sdkOptions()).toMatchObject({ apiKey: "legacy-key" });
    expect(sdkOptions({ apiKey: "explicit-key" })).toMatchObject({
      apiKey: "explicit-key",
    });
  });
});
