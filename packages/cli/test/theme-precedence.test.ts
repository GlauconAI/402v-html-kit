import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  loadTheme,
  resolveThemeSelection,
} from "../src/theme-loader.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot(label = "402v-cli-theme-") {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function themeSource(id: string) {
  return `export default Object.freeze({
    themeContractVersion: 1,
    id: ${JSON.stringify(id)},
    version: "1.0.0",
    displayName: ${JSON.stringify(id)},
    render(input) {
      return Object.freeze({ lang: input.metadata.lang || "en", styles: "", bodyHtml: "<main></main>" });
    }
  });\n`;
}

describe("CLI theme precedence", () => {
  it("uses flag, then manifest, then official default", () => {
    expect(
      resolveThemeSelection({
        flag: "./flag.mjs",
        manifest: "./manifest.mjs",
      }),
    ).toBe("./flag.mjs");
    expect(resolveThemeSelection({ manifest: "./manifest.mjs" })).toBe(
      "./manifest.mjs",
    );
    expect(resolveThemeSelection({})).toBe("@402v/theme-402v");
  });
});

describe("loadTheme", () => {
  it("loads an explicit local default export contained by the selected directory", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "theme.mjs"), themeSource("local-theme"));

    await expect(loadTheme("./theme.mjs", root)).resolves.toMatchObject({
      id: "local-theme",
      themeContractVersion: 1,
    });
  });

  it("loads an installed package and chooses theme402v when default is absent", async () => {
    const root = temporaryRoot();
    const packageRoot = join(root, "node_modules", "fixture-theme");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(root, "package.json"),
      '{"name":"fixture-consumer","private":true,"type":"module"}\n',
    );
    writeFileSync(
      join(packageRoot, "package.json"),
      '{"name":"fixture-theme","type":"module","exports":"./index.mjs"}\n',
    );
    writeFileSync(
      join(packageRoot, "index.mjs"),
      themeSource("package-theme").replace("export default", "export const theme402v ="),
    );

    await expect(loadTheme("fixture-theme", root)).resolves.toMatchObject({
      id: "package-theme",
      themeContractVersion: 1,
    });
  });

  it.each([
    ["remote URL", "https://example.com/theme.mjs"],
    ["file URL", "file:///tmp/theme.mjs"],
    ["NUL byte", "./theme\0.mjs"],
    ["empty string", ""],
    ["oversized specifier", "x".repeat(257)],
  ])("rejects a %s", async (_label, specifier) => {
    const root = temporaryRoot();
    await expect(loadTheme(specifier, root)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
  });

  it("rejects local traversal and a symlink whose canonical target escapes", async () => {
    const root = temporaryRoot();
    const outside = temporaryRoot("402v-cli-theme-outside-");
    writeFileSync(join(outside, "theme.mjs"), themeSource("escaped-theme"));
    symlinkSync(join(outside, "theme.mjs"), join(root, "linked-theme.mjs"));

    await expect(loadTheme("../theme.mjs", root)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
    await expect(loadTheme("./linked-theme.mjs", root)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
  });
});
