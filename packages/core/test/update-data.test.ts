import { createHash } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  chmodSync,
  linkSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildInteractiveArtifact,
  ArtifactBuildError,
  extractDataBlocks,
  updateArtifactData,
  verifyArtifact,
} from "../src/index.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function theme(
  render: (input: any) => any = (input) => ({
    lang: input.metadata.lang,
    styles: "",
    bodyHtml: `<main>${input.content.slots.mainSections ?? ""}</main>`,
  }),
) {
  return {
    themeContractVersion: 1 as const,
    id: "update-test-theme",
    version: "1.0.0",
    displayName: "Update Test Theme",
    render,
  };
}

async function builtProject() {
  const fixture = project();
  await buildInteractiveArtifact({
    manifestPath: fixture.manifestPath,
    outputPath: fixture.artifactPath,
    theme: theme(),
  });
  return fixture;
}

async function expectCode(run: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArtifactBuildError);
  expect(caught).toMatchObject({ code });
}

function project() {
  const root = mkdtempSync(join(tmpdir(), "html-kit-update-"));
  roots.push(root);
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "assets", "registry.json"), '{"manifest":true}');
  writeFileSync(join(root, "assets", "untouched.json"), '{"keep":"manifest"}');
  writeFileSync(
    join(root, "assets", "renderer.mjs"),
    `export function renderArtifact({ data }) {
       return { mainSections: '<section>' + JSON.stringify(data) + '</section>' };
     }`,
  );
  const manifestPath = join(root, "artifact.mjs");
  writeFileSync(
    manifestPath,
    `export default {
      contractVersion: 2,
      mode: "interactive",
      rootDirectory: "./assets",
      metadata: { title: "Update fixture", description: "Offline", eyebrow: "Test", lang: "en" },
      dataBlocks: [
        { id: "registry", source: "./registry.json" },
        { id: "untouched", source: "./untouched.json" }
      ],
      renderer: "./renderer.mjs",
      styles: [], scripts: [], svgAssets: [],
      requiredDataBlocks: ["registry", "untouched"]
    };`,
  );
  return { root, manifestPath, artifactPath: join(root, "artifact.html") };
}

describe("artifact data updates", () => {
  it("updates one contract-v2 block and preserves every other verified block", async () => {
    const fixture = project();
    await buildInteractiveArtifact({
      manifestPath: fixture.manifestPath,
      outputPath: fixture.artifactPath,
      theme: theme(),
    });
    const before = extractDataBlocks(readFileSync(fixture.artifactPath, "utf8"));

    const result = await updateArtifactData({
      artifactPath: fixture.artifactPath,
      manifestPath: fixture.manifestPath,
      id: "registry",
      value: { updated: true },
      theme: theme(),
    });
    const html = readFileSync(fixture.artifactPath, "utf8");
    const after = extractDataBlocks(html);

    expect(result).toEqual({
      ok: true,
      oldContract: 2,
      newContract: 2,
      theme: { id: "update-test-theme", version: "1.0.0" },
      sourceHash: verifyArtifact({ path: fixture.artifactPath }).sourceHash,
      outputHash: `sha256:${createHash("sha256").update(html).digest("hex")}`,
      preservedBlockIds: ["untouched"],
      outputPath: fixture.artifactPath,
    });
    expect(after.get("registry")).toEqual({ updated: true });
    expect(after.get("untouched")).toEqual(before.get("untouched"));
  }, 15_000);

  it("rejects invalid or missing ids and invalid/resource-heavy values without writes", async () => {
    const fixture = await builtProject();
    const before = readFileSync(fixture.artifactPath);
    const base = {
      artifactPath: fixture.artifactPath,
      manifestPath: fixture.manifestPath,
      theme: theme(),
    };
    await expectCode(
      () => updateArtifactData({ ...base, id: "bad id", value: {} }),
      "INVALID_DATA_BLOCK",
    );
    await expectCode(
      () => updateArtifactData({ ...base, id: "missing", value: {} }),
      "MISSING_DATA_BLOCK",
    );
    await expectCode(
      () => updateArtifactData({ ...base, id: "registry", value: undefined }),
      "INVALID_DATA_BLOCK",
    );
    let deep: any = null;
    for (let index = 0; index < 258; index += 1) deep = { child: deep };
    await expectCode(
      () => updateArtifactData({ ...base, id: "registry", value: deep }),
      "INVALID_DATA_BLOCK",
    );
    expect(readFileSync(fixture.artifactPath)).toEqual(before);
  }, 15_000);

  it.each([
    ["unsafe", (input: any) => ({ lang: input.metadata.lang, styles: "", bodyHtml: "<script>bad()</script>" }), "UNSAFE_THEME_OUTPUT"],
    ["throwing", () => { throw new Error("THEME_SECRET"); }, "THEME_RENDER_FAILED"],
  ] as const)("preserves source and destination for an %s theme", async (_label, render, code) => {
    const fixture = await builtProject();
    const outputPath = join(fixture.root, "output.html");
    writeFileSync(outputPath, "KEEP");
    const sourceBefore = readFileSync(fixture.artifactPath);
    const outputBefore = readFileSync(outputPath);
    await expectCode(
      () => updateArtifactData({
        artifactPath: fixture.artifactPath,
        manifestPath: fixture.manifestPath,
        id: "registry",
        value: { ready: false },
        outputPath,
        force: true,
        theme: theme(render),
      }),
      code,
    );
    expect(readFileSync(fixture.artifactPath)).toEqual(sourceBefore);
    expect(readFileSync(outputPath)).toEqual(outputBefore);
  }, 15_000);

  it("rejects invalid manifests and nondeterministic renderers before writing", async () => {
    const invalid = await builtProject();
    const invalidBefore = readFileSync(invalid.artifactPath);
    writeFileSync(invalid.manifestPath, "export default {};\n");
    await expectCode(
      () => updateArtifactData({
        artifactPath: invalid.artifactPath,
        manifestPath: invalid.manifestPath,
        id: "registry",
        value: {},
        theme: theme(),
      }),
      "INVALID_MANIFEST",
    );
    expect(readFileSync(invalid.artifactPath)).toEqual(invalidBefore);

    const nondeterministic = await builtProject();
    const nondeterministicBefore = readFileSync(nondeterministic.artifactPath);
    writeFileSync(
      join(nondeterministic.root, "assets", "renderer.mjs"),
      'export function renderArtifact(){return {mainSections:`<main>${Math.random()}</main>`};}',
    );
    await expectCode(
      () => updateArtifactData({
        artifactPath: nondeterministic.artifactPath,
        manifestPath: nondeterministic.manifestPath,
        id: "registry",
        value: {},
        theme: theme(),
      }),
      "NON_DETERMINISTIC_BUILD",
    );
    expect(readFileSync(nondeterministic.artifactPath)).toEqual(nondeterministicBefore);
  }, 20_000);

  it("honors distinct-output no-clobber and force semantics", async () => {
    const fixture = await builtProject();
    const sourceBefore = readFileSync(fixture.artifactPath);
    const outputPath = join(fixture.root, "output.html");
    writeFileSync(outputPath, "KEEP");
    await expectCode(
      () => updateArtifactData({
        artifactPath: fixture.artifactPath,
        manifestPath: fixture.manifestPath,
        id: "registry",
        value: { forced: true },
        outputPath,
        theme: theme(),
      }),
      "OUTPUT_EXISTS",
    );
    expect(readFileSync(outputPath, "utf8")).toBe("KEEP");
    await updateArtifactData({
      artifactPath: fixture.artifactPath,
      manifestPath: fixture.manifestPath,
      id: "registry",
      value: { forced: true },
      outputPath,
      force: true,
      theme: theme(),
    });
    expect(extractDataBlocks(readFileSync(outputPath, "utf8")).get("registry"))
      .toEqual({ forced: true });
    expect(readFileSync(fixture.artifactPath)).toEqual(sourceBefore);
  }, 15_000);

  it("rejects hardlink output aliases and symbolic-link artifact inputs", async () => {
    const hardlink = await builtProject();
    const aliasPath = join(hardlink.root, "alias.html");
    linkSync(hardlink.artifactPath, aliasPath);
    const before = readFileSync(hardlink.artifactPath);
    await expectCode(
      () => updateArtifactData({
        artifactPath: hardlink.artifactPath,
        manifestPath: hardlink.manifestPath,
        id: "registry",
        value: {},
        outputPath: aliasPath,
        force: true,
        theme: theme(),
      }),
      "INVALID_UPDATE_OPTIONS",
    );
    expect(readFileSync(hardlink.artifactPath)).toEqual(before);

    const symlink = await builtProject();
    const sourceLink = join(symlink.root, "source-link.html");
    symlinkSync("artifact.html", sourceLink);
    await expectCode(
      () => updateArtifactData({
        artifactPath: sourceLink,
        manifestPath: symlink.manifestPath,
        id: "registry",
        value: {},
        theme: theme(),
      }),
      "INVALID_UPDATE_OPTIONS",
    );
  }, 15_000);

  it("detects source mutation before install and preserves the raced bytes", async () => {
    const fixture = await builtProject();
    const outputPath = join(fixture.root, "output.html");
    writeFileSync(outputPath, "KEEP");
    let mutated = false;
    await expectCode(
      () => updateArtifactData({
        artifactPath: fixture.artifactPath,
        manifestPath: fixture.manifestPath,
        id: "registry",
        value: {},
        outputPath,
        force: true,
        verifyDeterminism: false,
        theme: theme((input) => {
          if (!mutated) {
            mutated = true;
            writeFileSync(fixture.artifactPath, "RACE-WINNER");
          }
          return { lang: "en", styles: "", bodyHtml: `<main>${input.content.slots.mainSections}</main>` };
        }),
      }),
      "ARTIFACT_CHANGED",
    );
    expect(readFileSync(fixture.artifactPath, "utf8")).toBe("RACE-WINNER");
    expect(readFileSync(outputPath, "utf8")).toBe("KEEP");
  }, 15_000);

  it("leaves no partial file after atomic replacement failure", async () => {
    const fixture = await builtProject();
    const unrelated = join(fixture.root, ".artifact.html.tmp-keep");
    writeFileSync(unrelated, "KEEP");
    const sourceBefore = readFileSync(fixture.artifactPath);
    chmodSync(fixture.root, 0o500);
    try {
      await expectCode(
        () => updateArtifactData({
          artifactPath: fixture.artifactPath,
          manifestPath: fixture.manifestPath,
          id: "registry",
          value: {},
          force: true,
          theme: theme(),
        }),
        "ATOMIC_WRITE_FAILED",
      );
    } finally {
      chmodSync(fixture.root, 0o700);
    }
    expect(readFileSync(fixture.artifactPath)).toEqual(sourceBefore);
    expect(readFileSync(unrelated, "utf8")).toBe("KEEP");
    expect(readdirSync(fixture.root).filter(
      (name) => name.includes(".artifact.html.tmp-") && name !== ".artifact.html.tmp-keep",
    )).toEqual([]);
  }, 15_000);

  it("rejects malformed artifact UTF-8 without touching a destination", async () => {
    const fixture = project();
    writeFileSync(fixture.artifactPath, Buffer.from([0xc3, 0x28]));
    const outputPath = join(fixture.root, "output.html");
    writeFileSync(outputPath, "KEEP");
    const sourceBefore = readFileSync(fixture.artifactPath);
    await expectCode(
      () => updateArtifactData({
        artifactPath: fixture.artifactPath,
        manifestPath: fixture.manifestPath,
        id: "registry",
        value: {},
        outputPath,
        force: true,
        theme: theme(),
      }),
      "ARTIFACT_READ_FAILED",
    );
    expect(readFileSync(fixture.artifactPath)).toEqual(sourceBefore);
    expect(readFileSync(outputPath, "utf8")).toBe("KEEP");
  });
});
