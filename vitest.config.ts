import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false,
    include: ["packages/**/*.test.ts", "tests/**/*.test.ts"],
  },
});
