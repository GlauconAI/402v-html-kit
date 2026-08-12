import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";

const root = new URL("../../", import.meta.url);

async function readManifest(relativePath: string): Promise<Record<string, unknown>> {
  const source = await readFile(new URL(relativePath, root), "utf8");
  return JSON.parse(source) as Record<string, unknown>;
}

describe("workspace package shape", () => {
  test("publishes the expected package surfaces", async () => {
    const rootManifest = await readManifest("package.json");
    const coreManifest = await readManifest("packages/core/package.json");
    const cliManifest = await readManifest("packages/cli/package.json");
    const themeManifest = await readManifest("packages/theme-402v/package.json");

    expect(rootManifest.workspaces).toEqual(["packages/*"]);
    expect(coreManifest.name).toBe("@402v/html-kit-core");
    expect(cliManifest.name).toBe("@402v/html-kit-cli");
    expect(themeManifest.name).toBe("@402v/theme-402v");
    expect(cliManifest.bin).toEqual({ "402v-html-kit": "./src/cli.mjs" });
    expect(rootManifest.engines).toEqual(
      expect.objectContaining({ node: "^22.13.0 || >=24.0.0" }),
    );

    for (const manifest of [coreManifest, cliManifest, themeManifest]) {
      expect(manifest.private).not.toBe(true);
      expect(manifest.type).toBe("module");
      expect(manifest.license).toBe("MIT");
      expect(manifest.repository).toEqual({
        type: "git",
        url: "https://github.com/GlauconAI/402v-html-kit",
      });
      expect(manifest.engines).toEqual(
        expect.objectContaining({ node: "^22.13.0 || >=24.0.0" }),
      );
      expect(manifest.files).toEqual(["src"]);
    }
  });
});
