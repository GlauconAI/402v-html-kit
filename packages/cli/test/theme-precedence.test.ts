import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
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
  it("assembles import rewrites with one linear join", () => {
    const loader = readFileSync(
      new URL("../src/theme-loader.mjs", import.meta.url),
      "utf8",
    );
    expect(loader).toContain('return chunks.join("");');
    expect(loader).not.toMatch(/rewritten\s*=.*rewritten\.slice/s);
  });

  it("loads an explicit local default export contained by the selected directory", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "theme.mjs"), themeSource("local-theme"));

    await expect(loadTheme("./theme.mjs", root)).resolves.toMatchObject({
      id: "local-theme",
      themeContractVersion: 1,
    });
  });

  it("preserves contained relative imports when executing a pinned local snapshot", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "helper.mjs"), 'export const themeId = "relative-theme";\n');
    writeFileSync(
      join(root, "theme.mjs"),
      `import { themeId } from "./helper.mjs";
       export default {
         themeContractVersion: 1, id: themeId, version: "1.0.0", displayName: themeId,
         render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; }
       };\n`,
    );

    await expect(loadTheme("./theme.mjs", root)).resolves.toMatchObject({
      id: "relative-theme",
    });
  });

  it("loads fresh relative dependency bytes on every invocation", async () => {
    const root = temporaryRoot();
    const helper = join(root, "helper.mjs");
    writeFileSync(helper, 'export const themeId = "first-theme";\n');
    writeFileSync(
      join(root, "theme.mjs"),
      `import { themeId } from "./helper.mjs";
       export default {
         themeContractVersion: 1, id: themeId, version: "1.0.0", displayName: themeId,
         render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; }
       };\n`,
    );

    await expect(loadTheme("./theme.mjs", root)).resolves.toMatchObject({
      id: "first-theme",
    });
    writeFileSync(helper, 'export const themeId = "second-theme";\n');
    await expect(loadTheme("./theme.mjs", root)).resolves.toMatchObject({
      id: "second-theme",
    });
  });

  it("never executes dependency replacement bytes introduced after graph pinning", async () => {
    const root = temporaryRoot();
    const sentinel = join(root, "dependency-attacker-ran");
    const helper = join(root, "helper.mjs");
    const replacement = join(root, "replacement-helper.mjs");
    writeFileSync(helper, 'export const themeId = "consistent-theme";\n');
    writeFileSync(
      replacement,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\nexport const themeId = "mixed-theme";\n`,
    );
    writeFileSync(
      join(root, "theme.mjs"),
      `import { themeId } from "./helper.mjs";
       export default {
         themeContractVersion: 1, id: themeId, version: "1.0.0", displayName: themeId,
         render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; }
       };\n`,
    );

    const pending = loadTheme("./theme.mjs", root);
    renameSync(replacement, helper);

    await expect(pending).resolves.toMatchObject({ id: "consistent-theme" });
    expect(() => statSync(sentinel)).toThrow();
  });

  it("snapshots export-from and literal dynamic-import dependencies", async () => {
    const root = temporaryRoot();
    writeFileSync(join(root, "helper.mjs"), 'export const themeId = "graph-theme";\n');
    writeFileSync(join(root, "bridge.mjs"), 'export { themeId } from "./helper.mjs";\n');
    writeFileSync(
      join(root, "theme.mjs"),
      `import { themeId } from "./bridge.mjs";
       const dynamic = await import("./helper.mjs");
       if (dynamic.themeId !== themeId) throw new Error("mixed graph");
       export default {
         themeContractVersion: 1, id: themeId, version: "1.0.0", displayName: themeId,
         render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; }
       };\n`,
    );

    await expect(loadTheme("./theme.mjs", root)).resolves.toMatchObject({
      id: "graph-theme",
    });
  });

  it("rejects nonliteral dynamic imports before executing local code", async () => {
    const root = temporaryRoot();
    const sentinel = join(root, "nonliteral-ran");
    writeFileSync(join(root, "helper.mjs"), 'export const themeId = "unsafe";\n');
    writeFileSync(
      join(root, "theme.mjs"),
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(sentinel)}, "ran");
       const target = "./helper.mjs";
       const { themeId } = await import(target);
       export default { themeContractVersion: 1, id: themeId, version: "1.0.0", displayName: themeId, render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; } };\n`,
    );

    await expect(loadTheme("./theme.mjs", root)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
    expect(() => statSync(sentinel)).toThrow();
  });

  it("rejects literal dynamic imports deferred inside theme methods", async () => {
    const root = temporaryRoot();
    const sentinel = join(root, "deferred-method-ran");
    writeFileSync(join(root, "helper.mjs"), "export const value = 1;\n");
    writeFileSync(
      join(root, "theme.mjs"),
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(sentinel)}, "ran");
       export default {
         themeContractVersion: 1, id: "x", version: "1.0.0", displayName: "x",
         render() {
           void import("./helper.mjs").catch(() => {});
           return { lang: "en", styles: "", bodyHtml: "<main></main>" };
         }
       };\n`,
    );

    await expect(loadTheme("./theme.mjs", root)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
    expect(() => statSync(sentinel)).toThrow();
    expect(
      readdirSync(root).filter((name) => name.startsWith(".402v-theme-")),
    ).toEqual([]);
  });

  it("rejects top-level literal dynamic imports that are not directly awaited", async () => {
    const root = temporaryRoot();
    const sentinel = join(root, "unawaited-import-ran");
    writeFileSync(join(root, "helper.mjs"), "export const value = 1;\n");
    writeFileSync(
      join(root, "theme.mjs"),
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(sentinel)}, "ran");
       void import("./helper.mjs").catch(() => {});
       export default { themeContractVersion: 1, id: "x", version: "1.0.0", displayName: "x", render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; } };\n`,
    );

    await expect(loadTheme("./theme.mjs", root)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
    expect(() => statSync(sentinel)).toThrow();
    expect(
      readdirSync(root).filter((name) => name.startsWith(".402v-theme-")),
    ).toEqual([]);
  });

  it("rejects directly awaited dynamic imports that are not relative", async () => {
    const root = temporaryRoot();
    const sentinel = join(root, "bare-dynamic-import-ran");
    writeFileSync(
      join(root, "theme.mjs"),
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(sentinel)}, "ran");
       await import("node:path");
       export default { themeContractVersion: 1, id: "x", version: "1.0.0", displayName: "x", render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; } };\n`,
    );

    await expect(loadTheme("./theme.mjs", root)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
    expect(() => statSync(sentinel)).toThrow();
  });

  it("rejects rewritten output expansion before allocating or executing", async () => {
    const root = temporaryRoot();
    const sentinel = join(root, "expanded-output-ran");
    const packageRoot = join(root, "node_modules", "fixture-expander");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({ name: "fixture-expander", type: "module", exports: "./index.mjs" }),
    );
    writeFileSync(join(packageRoot, "index.mjs"), "export {};\n");
    writeFileSync(
      join(root, "theme.mjs"),
      `${Array.from({ length: 32 }, () => 'import "fixture-expander";').join("\n")}
       import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(sentinel)}, "ran");
       export default { themeContractVersion: 1, id: "x", version: "1.0.0", displayName: "x", render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; } };\n`,
    );

    await expect(
      loadTheme("./theme.mjs", root, { maxSnapshotBytes: 2_048 }),
    ).rejects.toMatchObject({ code: "THEME_RESOLUTION_FAILED" });
    expect(() => statSync(sentinel)).toThrow();
  });

  it("rejects symlinked relative dependencies and bounded graph overflow", async () => {
    const symlinkRoot = temporaryRoot();
    writeFileSync(join(symlinkRoot, "real-helper.mjs"), 'export const value = "x";\n');
    symlinkSync(join(symlinkRoot, "real-helper.mjs"), join(symlinkRoot, "helper.mjs"));
    writeFileSync(
      join(symlinkRoot, "theme.mjs"),
      'import "./helper.mjs"; export default { themeContractVersion: 1, id: "x", version: "1.0.0", displayName: "x", render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; } };\n',
    );
    await expect(loadTheme("./theme.mjs", symlinkRoot)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });

    const countRoot = temporaryRoot();
    const imports = [];
    for (let index = 0; index < 65; index += 1) {
      const name = `dependency-${index}.mjs`;
      writeFileSync(join(countRoot, name), "export {};\n");
      imports.push(`import "./${name}";`);
    }
    writeFileSync(
      join(countRoot, "theme.mjs"),
      `${imports.join("\n")}\nexport default { themeContractVersion: 1, id: "x", version: "1.0.0", displayName: "x", render() { return { lang: "en", styles: "", bodyHtml: "<main></main>" }; } };\n`,
    );
    await expect(loadTheme("./theme.mjs", countRoot)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
  });

  it("always removes unique snapshot trees after success and import failure", async () => {
    const root = temporaryRoot();
    const snapshots = () =>
      readdirSync(root).filter((name) => name.startsWith(".402v-theme-"));
    writeFileSync(join(root, "theme.mjs"), themeSource("cleanup-theme"));
    await loadTheme("./theme.mjs", root);
    expect(snapshots()).toEqual([]);

    writeFileSync(
      join(root, "theme.mjs"),
      'throw new Error("import failed"); export default {};\n',
    );
    await expect(loadTheme("./theme.mjs", root)).rejects.toMatchObject({
      code: "THEME_RESOLUTION_FAILED",
    });
    expect(snapshots()).toEqual([]);
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

  it("uses createRequire resolution when a package exposes distinct require and import entries", async () => {
    const root = temporaryRoot();
    const packageRoot = join(root, "node_modules", "conditional-theme");
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(root, "package.json"), '{"name":"fixture-consumer","private":true}\n');
    writeFileSync(
      join(packageRoot, "package.json"),
      JSON.stringify({
        name: "conditional-theme",
        type: "module",
        exports: { import: "./import.mjs", require: "./require.cjs" },
      }),
    );
    writeFileSync(join(packageRoot, "import.mjs"), themeSource("import-theme"));
    writeFileSync(
      join(packageRoot, "require.cjs"),
      themeSource("require-theme")
        .replace("export default", "module.exports =")
        .replace(";\n", ";\n"),
    );

    await expect(loadTheme("conditional-theme", root)).resolves.toMatchObject({
      id: "require-theme",
    });
  });

  it("never executes replacement bytes introduced after a local module is pinned", async () => {
    const root = temporaryRoot();
    const sentinel = join(root, "attacker-ran");
    const selected = join(root, "theme.mjs");
    const replacement = join(root, "replacement.mjs");
    writeFileSync(selected, themeSource("pinned-theme"));
    writeFileSync(
      replacement,
      `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(sentinel)}, "ran");\n${themeSource("replacement-theme")}`,
    );

    const pending = loadTheme("./theme.mjs", root);
    renameSync(replacement, selected);

    await expect(pending).resolves.toMatchObject({ id: "pinned-theme" });
    expect(() => statSync(sentinel)).toThrow();
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
