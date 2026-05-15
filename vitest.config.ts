import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@codex-memory/core": `${root}packages/core/src/index.ts`,
      "@codex-memory/db": `${root}packages/db/src/index.ts`,
      "@codex-memory/providers": `${root}packages/providers/src/index.ts`,
      "@codex-memory/mcp-server": `${root}packages/mcp-server/src/index.ts`,
      "@codex-memory/shared": `${root}packages/shared/src/index.ts`
    }
  },
  test: {
    globals: true,
    environment: "node",
    include: ["**/*.test.ts", "**/*.test.tsx"]
  }
});
