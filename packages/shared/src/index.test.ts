import { describe, expect, it } from "vitest";
import {
  configFlagEnabled,
  createHealth,
  resolveMemoryMode,
  unsafeServerSynthesisFlag
} from "./index.js";

describe("createHealth", () => {
  it("creates an ok health payload", () => {
    expect(createHealth("test").status).toBe("ok");
  });
});

describe("resolveMemoryMode", () => {
  it("defaults to Codex subscription mode", () => {
    expect(resolveMemoryMode({})).toBe("codex_subscription");
    expect(resolveMemoryMode({ MEMORY_MODE: "codex_subscription" })).toBe(
      "codex_subscription"
    );
  });

  it("requires an explicit unsafe flag for server synthesis", () => {
    expect(() =>
      resolveMemoryMode({ MEMORY_MODE: "server_synthesis" })
    ).toThrow("backend-paid LLM calls");
    expect(
      resolveMemoryMode({
        MEMORY_MODE: "server_synthesis",
        [unsafeServerSynthesisFlag]: "1"
      })
    ).toBe("server_synthesis");
  });

  it("parses common truthy flag values", () => {
    expect(configFlagEnabled("true")).toBe(true);
    expect(configFlagEnabled(" YES ")).toBe(true);
    expect(configFlagEnabled("0")).toBe(false);
  });
});
