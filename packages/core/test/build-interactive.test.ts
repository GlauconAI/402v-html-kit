// @ts-expect-error jsdom does not publish declarations in this workspace.
import { JSDOM } from "jsdom";
import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_RESOURCE_LIMITS,
  ArtifactBuildError,
  buildInteractiveArtifact,
  buildNote,
  extractDataBlocks,
  verifyArtifact,
} from "../src/index.mjs";
import { theme402v } from "../../theme-402v/src/index.mjs";
import { loadArtifactManifest } from "../src/manifest.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "html-kit-interactive-"));
  roots.push(root);
  return root;
}

function theme(
  render: (input: any) => any = (input) => ({
    lang: input.metadata.lang,
    styles: ":root{color-scheme:light}.consumer{display:block}",
    bodyHtml: `<main>${input.content.slots.navigation ?? ""}${input.content.slots.heroSupplementary ?? ""}${input.content.slots.mainSections ?? ""}${input.content.slots.rail ?? ""}${input.content.slots.footer ?? ""}${input.content.svg.diagram?.html ?? ""}</main>`,
  }),
) {
  return {
    themeContractVersion: 1 as const,
    id: "test-theme",
    version: "1.2.3",
    displayName: "Test Theme",
    render,
  };
}

function writeProject(options: {
  manifestTheme?: string;
  renderer?: string;
  script?: string;
  data?: string;
  includeRequired?: boolean;
} = {}) {
  const root = temporaryRoot();
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "data.json"), options.data ?? '{"z":2,"a":{"ready":true}}');
  writeFileSync(
    join(root, "assets", "renderer.mjs"),
    options.renderer ?? `export function renderArtifact({ data, svg, metadata }) {
      const frozen = Object.isFrozen(data) && Object.isFrozen(data.registry) &&
        Object.isFrozen(svg) && Object.isFrozen(svg.diagram) && Object.isFrozen(metadata) &&
        Reflect.set(data.registry, "changed", true) === false;
      return {
        navigation: '<nav id="navigation">Nav</nav>',
        heroSupplementary: '<p id="hero">Hero</p>',
        mainSections: '<section id="main">' + data.registry.a.ready + ':' + frozen + '</section>',
        rail: '<aside id="rail">Rail</aside>',
        footer: '<footer id="footer">Footer</footer>'
      };
    }`,
  );
  writeFileSync(join(root, "assets", "consumer.css"), ".consumer{color:#123}");
  writeFileSync(
    join(root, "assets", "consumer.js"),
    options.script ?? 'window.consumerData=window.__htmlKitArtifact.getData("registry");',
  );
  writeFileSync(
    join(root, "assets", "diagram.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><title>Diagram</title><path d="M0 0h10v10z"/></svg>',
  );
  const manifestPath = join(root, "artifact.mjs");
  writeFileSync(
    manifestPath,
    `export default {
      contractVersion: 2,
      mode: "interactive",
      rootDirectory: "./assets",
      metadata: { title: "Interactive fixture", description: "Offline", eyebrow: "Test", lang: "en" },
      dataBlocks: [{ id: "registry", source: "./data.json" }],
      renderer: "./renderer.mjs",
      styles: ["./consumer.css"],
      scripts: ["./consumer.js"],
      svgAssets: [{ id: "diagram", source: "./diagram.svg", title: "System diagram" }],
      requiredDataBlocks: ${options.includeRequired === false ? '["missing"]' : '["registry"]'}${
        options.manifestTheme === undefined
          ? ""
          : `,\n      theme: ${JSON.stringify(options.manifestTheme)}`
      }
    };`,
  );
  return { manifestPath, outputPath: join(root, "artifact.html"), root };
}

function captureError(error: unknown, code: string) {
  expect(error).toBeInstanceOf(ArtifactBuildError);
  expect(error).toMatchObject({ code, name: "ArtifactBuildError" });
  return error as ArtifactBuildError;
}

async function expectRejection(run: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  return captureError(caught, code);
}

describe("themed interactive artifact build", () => {
  it("builds, verifies, hashes, and runs a complete contract-v2 artifact", async () => {
    const project = writeProject({ manifestTheme: "@not-installed/metadata-only" });
    const result = await buildInteractiveArtifact({
      manifestPath: project.manifestPath,
      outputPath: project.outputPath,
      theme: theme(),
    });
    const html = readFileSync(project.outputPath, "utf8");

    expect(result).toMatchObject({
      ok: true,
      contractVersion: 2,
      mode: "interactive",
      output: project.outputPath,
      title: "Interactive fixture",
      dataBlockIds: ["registry"],
      theme: { id: "test-theme", version: "1.2.3" },
    });
    expect(result.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(result.outputHash).toBe(
      `sha256:${createHash("sha256").update(html).digest("hex")}`,
    );
    expect(result.bytes).toBe(Buffer.byteLength(html));
    expect(extractDataBlocks(html).get("registry")).toEqual({
      a: { ready: true },
      z: 2,
    });
    expect(html).toContain('id="navigation"');
    expect(html).toContain('id="hero"');
    expect(html).toContain('id="main">true:true');
    expect(html).toContain('id="rail"');
    expect(html).toContain('id="footer"');
    expect(html).toContain(".consumer{color:#123}");
    expect(html).toContain("data-html-kit-runtime");
    expect(html).toContain("data-html-kit-consumer-script");
    expect(html.match(/<svg\b/g)).toHaveLength(1);
    expect(html).not.toContain("@not-installed/metadata-only");
    expect(html).not.toContain(project.root);

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    expect((dom.window as any).consumerData).toEqual({ a: { ready: true }, z: 2 });
    dom.window.close();
    expect(verifyArtifact({ path: project.outputPath })).toMatchObject({
      ok: true,
      contractVersion: 2,
      mode: "interactive",
      dataBlockIds: ["registry"],
    });
  });

  it("retains a manifest theme specifier only as inert bounded metadata", async () => {
    const project = writeProject({ manifestTheme: "@not-installed/metadata-only" });
    const manifest = await loadArtifactManifest(project.manifestPath);

    expect(manifest).toMatchObject({
      contractVersion: 2,
      mode: "interactive",
      theme: "@not-installed/metadata-only",
    });
    expect(manifest.renderer).toBe("renderer.mjs");
  });

  it("requires and validates the theme before any filesystem access", async () => {
    let getterCalls = 0;
    const hostile = theme();
    Object.defineProperty(hostile, "render", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => ({ lang: "en", styles: "", bodyHtml: "<main></main>" });
      },
    });

    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: "/definitely/missing/manifest.mjs",
        outputPath: "/definitely/missing/output.html",
      } as any),
      "INVALID_THEME",
    );
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: "/definitely/missing/manifest.mjs",
        outputPath: "/definitely/missing/output.html",
        theme: hostile,
      }),
      "INVALID_THEME",
    );
    expect(getterCalls).toBe(0);
  });

  it("renders the entire renderer-theme pipeline twice by default and once when disabled", async () => {
    const first = writeProject();
    let defaultCalls = 0;
    await buildInteractiveArtifact({
      manifestPath: first.manifestPath,
      outputPath: first.outputPath,
      theme: theme((input) => {
        defaultCalls += 1;
        return { lang: "en", styles: "", bodyHtml: `<main>${input.content.slots.mainSections}</main>` };
      }),
    });
    expect(defaultCalls).toBe(2);

    const second = writeProject();
    let singleCalls = 0;
    await buildInteractiveArtifact({
      manifestPath: second.manifestPath,
      outputPath: second.outputPath,
      theme: theme((input) => {
        singleCalls += 1;
        return { lang: "en", styles: "", bodyHtml: `<main>${input.content.slots.mainSections}</main>` };
      }),
      verifyDeterminism: false,
    });
    expect(singleCalls).toBe(1);
  });

  it("detects full-pipeline nondeterminism before writing", async () => {
    const rendererProject = writeProject({
      renderer: 'export function renderArtifact() { return { mainSections: `<main>${Math.random()}</main>` }; }',
    });
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: rendererProject.manifestPath,
        outputPath: rendererProject.outputPath,
        theme: theme(),
      }),
      "NON_DETERMINISTIC_BUILD",
    );
    expect(existsSync(rendererProject.outputPath)).toBe(false);

    const themeProject = writeProject();
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: themeProject.manifestPath,
        outputPath: themeProject.outputPath,
        theme: theme(() => ({
          lang: "en",
          styles: "",
          bodyHtml: `<main>${Math.random()}</main>`,
        })),
      }),
      "NON_DETERMINISTIC_BUILD",
    );
    expect(existsSync(themeProject.outputPath)).toBe(false);
  });

  it("reruns renderer module initialization during determinism verification", async () => {
    const project = writeProject({
      renderer: `const nonce = Math.random();
        export function renderArtifact() {
          return { mainSections: '<main>' + nonce + '</main>' };
        }`,
    });

    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: project.manifestPath,
        outputPath: project.outputPath,
        theme: theme(),
      }),
      "NON_DETERMINISTIC_BUILD",
    );
    expect(existsSync(project.outputPath)).toBe(false);
  });

  it("reloads manifest data sources for the second full pipeline", async () => {
    const project = writeProject();
    const dataPath = join(project.root, "assets", "data.json");
    writeFileSync(
      join(project.root, "assets", "renderer.mjs"),
      `export function renderArtifact({ data }) {
        process.getBuiltinModule("node:fs").writeFileSync(
          ${JSON.stringify(dataPath)},
          '{"z":2,"a":{"ready":false}}'
        );
        return { mainSections: '<main>' + data.registry.a.ready + '</main>' };
      }`,
    );

    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: project.manifestPath,
        outputPath: project.outputPath,
        theme: theme(),
      }),
      "NON_DETERMINISTIC_BUILD",
    );
    expect(existsSync(project.outputPath)).toBe(false);
  });

  it("keeps destinations unchanged after renderer, theme, or startup failure", async () => {
    const cases = [
      {
        project: writeProject({ renderer: 'export function renderArtifact() { throw new Error("RENDER_SECRET"); }' }),
        suppliedTheme: theme(),
        code: "INVALID_RENDERER_RESULT",
      },
      {
        project: writeProject(),
        suppliedTheme: theme(() => { throw new Error("THEME_SECRET"); }),
        code: "THEME_RENDER_FAILED",
      },
      {
        project: writeProject({ script: 'throw new Error("STARTUP_SECRET");' }),
        suppliedTheme: theme(),
        code: "ARTIFACT_VERIFICATION_FAILED",
      },
    ];
    for (const { project, suppliedTheme, code } of cases) {
      writeFileSync(project.outputPath, "KEEP");
      const error = await expectRejection(
        () => buildInteractiveArtifact({
          manifestPath: project.manifestPath,
          outputPath: project.outputPath,
          force: true,
          theme: suppliedTheme,
        }),
        code,
      );
      expect(readFileSync(project.outputPath, "utf8")).toBe("KEEP");
      if (code !== "ARTIFACT_VERIFICATION_FAILED") {
        expect(`${error.message}${JSON.stringify(error.details)}`).not.toMatch(/RENDER_SECRET|THEME_SECRET/);
      }
      expect(readdirSync(project.root).filter((name) => name.includes(".tmp-"))).toEqual([]);
    }
  });

  it.each([
    [
      "import failure",
      'throw new Error("IMPORT_RENDER_SECRET /private/renderer-path"); export function renderArtifact() { return {}; }',
      "IMPORT_RENDER_SECRET",
    ],
    [
      "synchronous throw",
      'export function renderArtifact() { throw new Error("SYNC_RENDER_SECRET /private/renderer-path"); }',
      "SYNC_RENDER_SECRET",
    ],
    [
      "async rejection",
      'export async function renderArtifact() { await Promise.resolve(); throw new Error("ASYNC_RENDER_SECRET /private/renderer-path"); }',
      "ASYNC_RENDER_SECRET",
    ],
    [
      "hostile result inspection",
      'export function renderArtifact() { return new Proxy({}, { ownKeys() { throw new Error("RESULT_RENDER_SECRET /private/renderer-path"); } }); }',
      "RESULT_RENDER_SECRET",
    ],
  ])("redacts renderer %s across every public error surface", async (_label, renderer, sentinel) => {
    const project = writeProject({ renderer });
    const error = await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: project.manifestPath,
        outputPath: project.outputPath,
        theme: theme(),
        verifyDeterminism: false,
      }),
      "INVALID_RENDERER_RESULT",
    );

    expect((error as Error & { cause?: unknown }).cause).toBeUndefined();
    const surfaces = [
      error.message,
      JSON.stringify(error.details),
      JSON.stringify(error.toJSON()),
      JSON.stringify(error),
      inspect(error, { depth: 8 }),
      inspect((error as Error & { cause?: unknown }).cause, { depth: 8 }),
    ].join("\n");
    expect(surfaces).not.toContain(sentinel);
    expect(surfaces).not.toContain("/private/renderer-path");
    expect(surfaces).not.toContain(project.root);
    expect(existsSync(project.outputPath)).toBe(false);
  });

  it("rejects malformed options, manifest objects, entries, aliases, and force misuse", async () => {
    const project = writeProject();
    const hostileOptions = Object.create({ inherited: true });
    Object.assign(hostileOptions, {
      manifestPath: project.manifestPath,
      outputPath: project.outputPath,
      theme: theme(),
    });
    await expectRejection(() => buildInteractiveArtifact(hostileOptions), "INVALID_BUILD_OPTIONS");
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: project.manifestPath,
        outputPath: project.outputPath,
        force: "yes",
        theme: theme(),
      } as any),
      "INVALID_BUILD_OPTIONS",
    );
    await expectRejection(
      () => buildInteractiveArtifact(Object.assign({
        manifestPath: project.manifestPath,
        outputPath: project.outputPath,
        theme: theme(),
      }, { [Symbol("unsafe")]: true }) as any),
      "INVALID_BUILD_OPTIONS",
    );

    const getterProject = writeProject();
    writeFileSync(getterProject.manifestPath, `const value = {};
      Object.defineProperty(value, "mode", { enumerable: true, get() { throw new Error("GETTER_SECRET"); } });
      export default value;`);
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: getterProject.manifestPath,
        outputPath: getterProject.outputPath,
        theme: theme(),
      }),
      "INVALID_MANIFEST",
    );

    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: project.manifestPath,
        outputPath: project.manifestPath,
        force: true,
        theme: theme(),
      }),
      "INVALID_BUILD_OPTIONS",
    );
    linkSync(project.manifestPath, project.outputPath);
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: project.manifestPath,
        outputPath: project.outputPath,
        force: true,
        theme: theme(),
      }),
      "INVALID_BUILD_OPTIONS",
    );
  });

  it("normalizes revoked build and verify option proxies", async () => {
    const build = Proxy.revocable({}, {});
    build.revoke();
    await expectRejection(
      () => buildInteractiveArtifact(build.proxy as any),
      "INVALID_BUILD_OPTIONS",
    );

    const verify = Proxy.revocable({}, {});
    verify.revoke();
    let caught: unknown;
    try {
      verifyArtifact(verify.proxy as any);
    } catch (error) {
      caught = error;
    }
    captureError(caught, "INVALID_VERIFY_OPTIONS");
  });

  it.each(["prototype", "symbol"])(
    "rejects a manifest with a hostile %s shape",
    async (shape) => {
      const project = writeProject();
      const expression = readFileSync(project.manifestPath, "utf8").replace(
        /^export default /,
        "",
      );
      writeFileSync(
        project.manifestPath,
        `const value = ${expression}\n${
          shape === "prototype"
            ? "Object.setPrototypeOf(value, { inherited: true });"
            : 'value[Symbol("unsafe")] = true;'
        }\nexport default value;`,
      );

      await expectRejection(
        () => buildInteractiveArtifact({
          manifestPath: project.manifestPath,
          outputPath: project.outputPath,
          theme: theme(),
        }),
        "INVALID_MANIFEST",
      );
      expect(existsSync(project.outputPath)).toBe(false);
    },
  );

  it.each(["getter", "prototype", "symbol"])(
    "rejects a renderer result with a hostile %s shape without writing",
    async (shape) => {
      const expression =
        shape === "getter"
          ? `const value = {}; Object.defineProperty(value, "mainSections", { enumerable: true, get() { throw new Error("GETTER_SECRET"); } }); return value;`
          : shape === "prototype"
            ? `return Object.assign(new (class Result {})(), { mainSections: "<main>Unsafe</main>" });`
            : `return { mainSections: "<main>Unsafe</main>", [Symbol("unsafe")]: true };`;
      const project = writeProject({
        renderer: `export function renderArtifact() { ${expression} }`,
      });

      const error = await expectRejection(
        () => buildInteractiveArtifact({
          manifestPath: project.manifestPath,
          outputPath: project.outputPath,
          theme: theme(),
        }),
        "INVALID_RENDERER_RESULT",
      );
      expect(`${error.message}${JSON.stringify(error.details)}`).not.toContain(
        "GETTER_SECRET",
      );
      expect(existsSync(project.outputPath)).toBe(false);
    },
  );

  it("preserves no-clobber, dangling symlink, and atomic race behavior", async () => {
    const existing = writeProject();
    writeFileSync(existing.outputPath, "EXISTING");
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: existing.manifestPath,
        outputPath: existing.outputPath,
        theme: theme(),
      }),
      "OUTPUT_EXISTS",
    );
    expect(readFileSync(existing.outputPath, "utf8")).toBe("EXISTING");

    const dangling = writeProject();
    symlinkSync("missing.html", dangling.outputPath);
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: dangling.manifestPath,
        outputPath: dangling.outputPath,
        theme: theme(),
      }),
      "OUTPUT_EXISTS",
    );
    expect(lstatSync(dangling.outputPath).isSymbolicLink()).toBe(true);
    expect(readlinkSync(dangling.outputPath)).toBe("missing.html");

    const race = writeProject({
      renderer: `export function renderArtifact() {
        process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(join(temporaryRoot(), "unused"))}, "x");
        return { mainSections: "<main>Ready</main>" };
      }`,
    });
    writeFileSync(
      join(race.root, "assets", "renderer.mjs"),
      `export function renderArtifact() {
        process.getBuiltinModule("node:fs").writeFileSync(${JSON.stringify(race.outputPath)}, "RACE-WINNER");
        return { mainSections: "<main>Ready</main>" };
      }`,
    );
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: race.manifestPath,
        outputPath: race.outputPath,
        theme: theme(),
        verifyDeterminism: false,
      }),
      "OUTPUT_EXISTS",
    );
    expect(readFileSync(race.outputPath, "utf8")).toBe("RACE-WINNER");
    expect(readdirSync(race.root).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it.each([
    ["renderer", false],
    ["theme", true],
  ] as const)(
    "rejects an output parent symlink redirected by the %s without touching the manifest",
    async (mutator, verifyDeterminism) => {
      const project = writeProject();
      const safeParent = join(project.root, "safe-output");
      const parentLink = join(project.root, "output-parent");
      mkdirSync(safeParent);
      symlinkSync("safe-output", parentLink);
      const outputPath = join(parentLink, "artifact.mjs");
      const originalManifest = readFileSync(project.manifestPath, "utf8");
      const redirect = () => {
        rmSync(parentLink);
        symlinkSync(".", parentLink);
      };

      let suppliedTheme = theme();
      if (mutator === "renderer") {
        writeFileSync(
          join(project.root, "assets", "renderer.mjs"),
          `export function renderArtifact() {
            const fs = process.getBuiltinModule("node:fs");
            fs.unlinkSync(${JSON.stringify(parentLink)});
            fs.symlinkSync(".", ${JSON.stringify(parentLink)});
            return { mainSections: "<main>Ready</main>" };
          }`,
        );
      } else {
        let redirected = false;
        suppliedTheme = theme((input) => {
          if (!redirected) {
            redirected = true;
            redirect();
          }
          return {
            lang: "en",
            styles: "",
            bodyHtml: `<main>${input.content.slots.mainSections}</main>`,
          };
        });
      }

      await expectRejection(
        () => buildInteractiveArtifact({
          manifestPath: project.manifestPath,
          outputPath,
          force: true,
          theme: suppliedTheme,
          verifyDeterminism,
        }),
        "INVALID_BUILD_OPTIONS",
      );
      expect(readFileSync(project.manifestPath, "utf8")).toBe(originalManifest);
      expect(existsSync(join(safeParent, "artifact.mjs"))).toBe(false);
    },
  );

  it.each(["hardlink", "symlink"])(
    "rechecks a manifest %s installed as the destination during rendering",
    async (aliasKind) => {
      const project = writeProject();
      const originalManifest = readFileSync(project.manifestPath, "utf8");
      writeFileSync(
        join(project.root, "assets", "renderer.mjs"),
        `export function renderArtifact() {
          const fs = process.getBuiltinModule("node:fs");
          fs.${aliasKind === "hardlink" ? "linkSync" : "symlinkSync"}(
            ${JSON.stringify(project.manifestPath)},
            ${JSON.stringify(project.outputPath)}
          );
          return { mainSections: "<main>Ready</main>" };
        }`,
      );

      await expectRejection(
        () => buildInteractiveArtifact({
          manifestPath: project.manifestPath,
          outputPath: project.outputPath,
          force: true,
          theme: theme(),
          verifyDeterminism: false,
        }),
        "INVALID_BUILD_OPTIONS",
      );
      expect(readFileSync(project.manifestPath, "utf8")).toBe(originalManifest);
    },
  );

  it("does not create a missing output parent while trying to pin it", async () => {
    const project = writeProject();
    const missingParent = join(project.root, "missing", "output");

    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: project.manifestPath,
        outputPath: join(missingParent, "artifact.html"),
        theme: theme(),
      }),
      "INVALID_BUILD_OPTIONS",
    );
    expect(existsSync(missingParent)).toBe(false);
  });

  it("rejects traversal and escaping symlinks under the trusted root", async () => {
    const traversal = writeProject();
    writeFileSync(
      traversal.manifestPath,
      readFileSync(traversal.manifestPath, "utf8").replace('"./renderer.mjs"', '"../artifact.mjs"'),
    );
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: traversal.manifestPath,
        outputPath: traversal.outputPath,
        theme: theme(),
      }),
      "UNSAFE_ENTRY_PATH",
    );

    const symlink = writeProject();
    const outside = join(symlink.root, "outside.mjs");
    writeFileSync(outside, "export function renderArtifact(){return {}};");
    rmSync(join(symlink.root, "assets", "renderer.mjs"));
    symlinkSync(outside, join(symlink.root, "assets", "renderer.mjs"));
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: symlink.manifestPath,
        outputPath: symlink.outputPath,
        theme: theme(),
      }),
      "UNSAFE_ENTRY_PATH",
    );
  });

  it("enforces strict UTF-8, bounded manifest theme metadata, required blocks, and resource caps", async () => {
    const utf8 = writeProject();
    writeFileSync(utf8.manifestPath, Buffer.from([0xff, 0xfe]));
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: utf8.manifestPath,
        outputPath: utf8.outputPath,
        theme: theme(),
      }),
      "INVALID_MANIFEST",
    );

    const themeMetadata = writeProject({ manifestTheme: "x".repeat(257) });
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: themeMetadata.manifestPath,
        outputPath: themeMetadata.outputPath,
        theme: theme(),
      }),
      "INVALID_MANIFEST",
    );

    const required = writeProject({ includeRequired: false });
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: required.manifestPath,
        outputPath: required.outputPath,
        theme: theme(),
      }),
      "INVALID_MANIFEST",
    );

    const capped = writeProject({ data: JSON.stringify({ text: "x".repeat(ARTIFACT_RESOURCE_LIMITS.rawJsonBytes + 1) }) });
    await expectRejection(
      () => buildInteractiveArtifact({
        manifestPath: capped.manifestPath,
        outputPath: capped.outputPath,
        theme: theme(),
      }),
      "INVALID_DATA_BLOCK",
    );
    expect(existsSync(capped.outputPath)).toBe(false);
  });

  it("keeps the public verifier contract-neutral and validates options without getters", () => {
    let getterCalls = 0;
    const hostile: any = {};
    Object.defineProperty(hostile, "path", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "/secret";
      },
    });
    let caught: unknown;
    try {
      verifyArtifact(hostile);
    } catch (error) {
      caught = error;
    }
    captureError(caught, "INVALID_VERIFY_OPTIONS");
    expect(getterCalls).toBe(0);

    const root = temporaryRoot();
    const invalidPath = join(root, "invalid.html");
    writeFileSync(invalidPath, Buffer.from([0xff]));
    let utf8Error: unknown;
    try {
      verifyArtifact({ path: invalidPath });
    } catch (error) {
      utf8Error = error;
    }
    const failure = captureError(utf8Error, "ARTIFACT_VERIFICATION_FAILED");
    expect(failure.details).toMatchObject({
      issues: expect.arrayContaining([
        expect.objectContaining({ code: "INVALID_UTF8" }),
      ]),
    });
  });

  it("keeps themed note and official-theme behavior compatible across modes", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "note.md");
    const noteOutput = join(root, "note.html");
    writeFileSync(inputPath, "# Note\n\nCompatible.");
    const note = await buildNote({ inputPath, outputPath: noteOutput, theme: theme402v });
    expect(note).toMatchObject({ contractVersion: 2, mode: "note", theme: { id: "402v" } });

    const project = writeProject();
    const interactive = await buildInteractiveArtifact({
      manifestPath: project.manifestPath,
      outputPath: project.outputPath,
      theme: theme402v,
    });
    expect(interactive).toMatchObject({ contractVersion: 2, mode: "interactive", theme: { id: "402v" } });
    expect(readFileSync(project.outputPath, "utf8")).toContain("402v / interactive");
  });
});
