import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const smokeScript = fileURLToPath(new URL("./pack-smoke.mjs", import.meta.url));

describe("packed clean consumer", () => {
  it("installs and exercises only the three produced package tarballs", () => {
    const result = spawnSync(process.execPath, [smokeScript], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--no-warnings",
        NODE_PATH: "/host/modules-must-not-resolve",
        NPM_CONFIG_CACHE: "/host/cache-must-not-be-used",
        NO_COLOR: "1",
        YARN_GLOBAL_FOLDER: "/host/yarn-must-not-be-used",
        npm_config_registry: "https://private.invalid",
      },
      timeout: 180_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.endsWith("\n")).toBe(true);

    const summary = JSON.parse(result.stdout.trimEnd());
    expect(summary).toMatchObject({
      ok: true,
      binaryExecutable: true,
      commands: ["note", "build-artifact", "verify", "update-data"],
      imports: [
        "@402v/html-kit-core",
        "@402v/html-kit-cli",
        "@402v/theme-402v",
      ],
    });
    expect(summary.packages).toEqual([
      expect.objectContaining({ name: "@402v/html-kit-cli" }),
      expect.objectContaining({ name: "@402v/html-kit-core" }),
      expect.objectContaining({ name: "@402v/theme-402v" }),
    ]);
  }, 180_000);
});
