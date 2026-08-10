import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ArtifactBuildError,
  extractDataBlocks,
  updateArtifactData,
  verifyArtifact,
} from "@402v/html-kit-core";
import { theme402v } from "@402v/theme-402v";

const roots: string[] = [];
const v1Interactive = new URL("./fixtures/v1/interactive.html", import.meta.url);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("explicit contract-v1 upgrade", () => {
  it("rejects v1 without explicit upgrade before manifest or theme work", async () => {
    const root = mkdtempSync(join(tmpdir(), "html-kit-v1-upgrade-red-"));
    roots.push(root);
    const artifactPath = join(root, "artifact.html");
    const outputPath = join(root, "output.html");
    const manifestPath = join(root, "artifact.mjs");
    const markerPath = join(root, "manifest-imported");
    copyFileSync(v1Interactive, artifactPath);
    writeFileSync(outputPath, "destination sentinel\n");
    writeFileSync(
      manifestPath,
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(markerPath)}, "imported");
       export default {};
      `,
    );
    const sourceBefore = readFileSync(artifactPath);
    const destinationBefore = readFileSync(outputPath);

    let caught: unknown;
    try {
      await updateArtifactData({
        artifactPath,
        manifestPath,
        id: "project-registry",
        value: { updated: true },
        outputPath,
        force: true,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ArtifactBuildError);
    expect(caught).toMatchObject({ code: "CONTRACT_UPGRADE_REQUIRED" });
    expect(existsSync(markerPath)).toBe(false);
    expect(readFileSync(artifactPath)).toEqual(sourceBefore);
    expect(readFileSync(outputPath)).toEqual(destinationBefore);
  });

  it("gates a detectable v1 with a corrupt source hash before full verification", async () => {
    const root = mkdtempSync(join(tmpdir(), "html-kit-v1-corrupt-gate-"));
    roots.push(root);
    const artifactPath = join(root, "artifact.html");
    const outputPath = join(root, "output.html");
    const manifestPath = join(root, "artifact.mjs");
    const manifestMarker = join(root, "manifest-imported");
    const themeMarker = join(root, "theme-rendered");
    const fixture = readFileSync(v1Interactive, "utf8");
    const corrupted = fixture.replace('"name": "Agent Atlas"', '"name": "Agent AtlaX"');
    expect(corrupted).not.toBe(fixture);
    writeFileSync(artifactPath, corrupted);
    writeFileSync(outputPath, "destination sentinel\n");
    writeFileSync(
      manifestPath,
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(manifestMarker)}, "imported");
       export default {};`,
    );
    const sourceBefore = readFileSync(artifactPath);
    const destinationBefore = readFileSync(outputPath);

    let caught: unknown;
    try {
      await updateArtifactData({
        artifactPath,
        manifestPath,
        id: "project-registry",
        value: { updated: true },
        outputPath,
        force: true,
        theme: {
          themeContractVersion: 1,
          id: "gate-side-effect",
          version: "1.0.0",
          displayName: "Gate Side Effect",
          render() {
            writeFileSync(themeMarker, "rendered");
            return { lang: "en", styles: "", bodyHtml: "<main></main>" };
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ArtifactBuildError);
    expect(caught).toMatchObject({ code: "CONTRACT_UPGRADE_REQUIRED" });
    expect(existsSync(manifestMarker)).toBe(false);
    expect(existsSync(themeMarker)).toBe(false);
    expect(readFileSync(artifactPath)).toEqual(sourceBefore);
    expect(readFileSync(outputPath)).toEqual(destinationBefore);

    caught = undefined;
    try {
      await updateArtifactData({
        artifactPath,
        manifestPath,
        id: "project-registry",
        value: { updated: true },
        outputPath,
        force: true,
        theme: theme402v,
        upgradeContract: 2,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ArtifactBuildError);
    expect(caught).toMatchObject({ code: "ARTIFACT_VERIFICATION_FAILED" });
    expect(existsSync(manifestMarker)).toBe(false);
    expect(existsSync(themeMarker)).toBe(false);
    expect(readFileSync(artifactPath)).toEqual(sourceBefore);
    expect(readFileSync(outputPath)).toEqual(destinationBefore);
  });

  it("deterministically upgrades v1 to verified v2 with the official theme", async () => {
    const root = mkdtempSync(join(tmpdir(), "html-kit-v1-upgrade-"));
    roots.push(root);
    const artifactPath = join(root, "artifact.html");
    const firstOutput = join(root, "first.html");
    const secondOutput = join(root, "second.html");
    const manifestPath = join(root, "artifact.mjs");
    mkdirSync(join(root, "assets"));
    copyFileSync(v1Interactive, artifactPath);
    writeFileSync(join(root, "assets", "registry.json"), '{"manifest":"ignored"}');
    writeFileSync(
      join(root, "assets", "renderer.mjs"),
      `export function renderArtifact({ data }) {
         return { mainSections: '<section>' + JSON.stringify(data["project-registry"]) + '</section>' };
       }`,
    );
    writeFileSync(
      manifestPath,
      `export default {
        contractVersion: 2,
        mode: "interactive",
        rootDirectory: "./assets",
        metadata: { title: "Upgraded fixture", description: "Offline", eyebrow: "Compat", lang: "en" },
        dataBlocks: [{ id: "project-registry", source: "./registry.json" }],
        renderer: "./renderer.mjs",
        styles: [], scripts: [], svgAssets: [],
        requiredDataBlocks: ["project-registry"]
      };`,
    );
    const before = readFileSync(artifactPath);
    const replacement = { projects: [{ id: "upgraded", ready: true }] };

    const first = await updateArtifactData({
      artifactPath,
      manifestPath,
      id: "project-registry",
      value: replacement,
      outputPath: firstOutput,
      theme: theme402v,
      upgradeContract: 2,
    });
    const second = await updateArtifactData({
      artifactPath,
      manifestPath,
      id: "project-registry",
      value: replacement,
      outputPath: secondOutput,
      theme: theme402v,
      upgradeContract: 2,
    });

    expect(readFileSync(firstOutput)).toEqual(readFileSync(secondOutput));
    expect(readFileSync(artifactPath)).toEqual(before);
    expect(first).toMatchObject({
      ok: true,
      oldContract: 1,
      newContract: 2,
      theme: { id: "402v", version: "0.1.0" },
      preservedBlockIds: [],
      outputPath: firstOutput,
    });
    expect(second.outputHash).toBe(first.outputHash);
    expect(extractDataBlocks(readFileSync(firstOutput, "utf8")).get("project-registry"))
      .toEqual(replacement);
    expect(verifyArtifact({ path: firstOutput })).toMatchObject({
      ok: true,
      contractVersion: 2,
      mode: "interactive",
      dataBlockIds: ["project-registry"],
    });
  }, 20_000);
});
