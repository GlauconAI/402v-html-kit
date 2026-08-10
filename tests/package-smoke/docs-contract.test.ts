import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../", import.meta.url));
const requiredDocuments = [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "CONTRIBUTING.md",
  "CHANGELOG.md",
  ".github/PULL_REQUEST_TEMPLATE.md",
  "docs/architecture.md",
  "docs/artifact-contract-v2.md",
  "docs/theme-contract-v1.md",
  "docs/migration-from-internal-v1.md",
  "docs/security-model.md",
] as const;

const publicApi = [
  "ARTIFACT_RESOURCE_LIMITS",
  "ArtifactBuildError",
  "assembleArtifactV2",
  "buildInteractiveArtifact",
  "buildNote",
  "canonicalizeJson",
  "computeSourceHash",
  "detectArtifactContract",
  "extractDataBlocks",
  "renderThemeV1",
  "serializeDataBlocks",
  "stableJson",
  "updateArtifactData",
  "verifyArtifact",
  "verifyArtifactHtml",
].sort();

function read(relativePath: string): string {
  return readFileSync(resolve(root, relativePath), "utf8");
}

function markedItems(source: string, marker: string): string[] {
  const match = source.match(
    new RegExp(`<!-- ${marker}:start -->([\\s\\S]*?)<!-- ${marker}:end -->`, "u"),
  );
  expect(match, `missing ${marker} marker pair`).not.toBeNull();
  return [...(match?.[1].matchAll(/^- `([^`]+)`$/gmu) ?? [])]
    .map((entry) => entry[1])
    .sort();
}

describe("public documentation contract", () => {
  it("contains every required public document", () => {
    const missing = requiredDocuments.filter(
      (relativePath) => !existsSync(resolve(root, relativePath)),
    );
    expect(missing, `missing public documents: ${missing.join(", ")}`).toEqual([]);
    for (const relativePath of requiredDocuments) {
      expect(read(relativePath).trim().length, `${relativePath} is empty`).toBeGreaterThan(40);
    }
  });

  it("documents packages, runnable modes, support, trust, offline behavior, and scope", () => {
    const readme = read("README.md");
    for (const packageName of [
      "@402v/html-kit-core",
      "@402v/html-kit-cli",
      "@402v/theme-402v",
    ]) {
      expect(readme).toContain(packageName);
    }
    expect(readme).toMatch(/## Note quick start[\s\S]*402v-html-kit build examples\/note\/input\.md/u);
    expect(readme).toMatch(/## Interactive quick start[\s\S]*402v-html-kit build-artifact examples\/interactive\/artifact\.mjs/u);
    expect(readme).toMatch(/## Custom theme quick start[\s\S]*--theme \.\/examples\/custom-theme\/artifact-theme\.mjs/u);
    expect(readme).toContain("^22.13.0 || >=24.0.0");
    expect(readme).toMatch(/Node 22[\s\S]*Node 24/u);
    expect(readme).toMatch(/trusted local build-time code[\s\S]*not sandboxed/iu);
    expect(readme).toMatch(/self-contained[\s\S]*offline/iu);
    expect(readme).toMatch(/remote Markdown\s+images[\s\S]*passive links/iu);
    expect(readme).toMatch(/contract-v1 note verification[\s\S]*remote image compatibility/iu);
    expect(readme).toContain("docs/migration-from-internal-v1.md");
    expect(readme).toMatch(/Publishing[\s\S]*outside (?:this project|the project)/iu);
    expect(readme).toMatch(/External setup gates[\s\S]*not yet/u);
    expect(readme).toMatch(/npm settings for each of the three packages[\s\S]*release\.yml[\s\S]*environment `npm`/u);
  });

  it("lists exactly the fifteen current core exports and exact CLI help", async () => {
    const architecture = read("docs/architecture.md");
    expect(markedItems(architecture, "public-api")).toEqual(publicApi);
    const core = await import("../../packages/core/src/index.mjs");
    expect(Object.keys(core).sort()).toEqual(publicApi);

    const readme = read("README.md");
    const documented = readme.match(
      /<!-- cli-help:start -->\n```text\n([\s\S]*?)```\n<!-- cli-help:end -->/u,
    )?.[1];
    expect(documented).toBe(
      [
        "402v HTML Kit",
        "",
        "Usage:",
        "  402v-html-kit init <directory> --title <title> [--theme <specifier>] [--force]",
        "  402v-html-kit build <input.md> [--theme <specifier>] [--output <html>] [--force]",
        "  402v-html-kit build-artifact <manifest.mjs> [--theme <specifier>] [--output <html>] [--preserve-data-from <html>] [--force]",
        "  402v-html-kit update-data <artifact.html> --manifest <manifest.mjs> --id <id> --input <json> [--theme <specifier>] [--output <html>] [--upgrade-contract 2] [--force]",
        "  402v-html-kit verify <artifact.html> [--required-block <id>]...",
        "",
      ].join("\n"),
    );
  });

  it("records current v2, v1, theme, error, and resource contracts", () => {
    const artifact = read("docs/artifact-contract-v2.md");
    for (const identifier of [
      "html-kit-artifact-contract",
      "html-kit-artifact-mode",
      "html-kit-source-hash",
      "data-html-kit-runtime",
      "data-html-kit-root",
      "data-html-kit-consumer-script",
      "__htmlKitArtifact",
    ]) {
      expect(artifact).toContain(identifier);
    }
    expect(artifact).toMatch(/getData\(id\)[\s\S]*dataIds\(\)[\s\S]*root/u);

    const migration = read("docs/migration-from-internal-v1.md");
    expect(migration).toMatch(/verify[\s\S]*v1/iu);
    expect(migration).toMatch(/extractDataBlocks[\s\S]*v1 and v2/iu);
    expect(migration).toContain("CONTRACT_UPGRADE_REQUIRED");
    expect(migration).toContain("--upgrade-contract 2");
    expect(migration).toMatch(/--preserve-data-from[\s\S]*COMMAND_UNAVAILABLE/u);

    const theme = read("docs/theme-contract-v1.md");
    for (const declaration of [
      "themeContractVersion: 1",
      "id: string",
      "version: string",
      "displayName: string",
      "render(input: ThemeRenderInput): ThemeRenderResult",
    ]) {
      expect(theme).toContain(declaration);
    }

    const security = read("docs/security-model.md");
    for (const value of [
      "67,108,864",
      "33,554,432",
      "250,000",
      "8,388,608",
      "20,971,520",
      "4,194,304",
    ]) {
      expect(security).toContain(value);
    }
    expect(security).toMatch(/ArtifactBuildError[\s\S]*code[\s\S]*message[\s\S]*details/u);
  });

  it("defines governance, disclosure, release ownership, and MIT terms", () => {
    expect(read("LICENSE")).toContain("Copyright (c) 2026 GlauconAI");
    expect(read("LICENSE")).toContain("Permission is hereby granted, free of charge");
    expect(read("SECURITY.md")).toMatch(/themes\s+execute as trusted local build-time code[\s\S]*not sandboxed/iu);
    expect(read("SECURITY.md")).toMatch(/Reporting a vulnerability[\s\S]*privately/iu);
    expect(read("CONTRIBUTING.md")).toMatch(/Semantic Versioning|SemVer/u);
    expect(read("CONTRIBUTING.md")).toMatch(/GlauconAI maintainers[\s\S]*release/iu);
    expect(read("CHANGELOG.md")).toContain("## [0.1.0]");
    const pullRequest = read(".github/PULL_REQUEST_TEMPLATE.md");
    for (const requirement of [
      /TDD|failing test/iu,
      /typecheck/iu,
      /full test/iu,
      /deterministic/iu,
      /pack/iu,
      /license/iu,
      /forbidden/iu,
      /security boundar/iu,
      /documentation|docs/iu,
      /changelog/iu,
      /publish|deploy/iu,
      /authoriz/iu,
    ]) {
      expect(pullRequest).toMatch(requirement);
    }
  });

  it("keeps every local Markdown link resolvable", () => {
    for (const relativePath of requiredDocuments.filter((path) => path.endsWith(".md"))) {
      const source = read(relativePath);
      const directory = dirname(resolve(root, relativePath));
      for (const match of source.matchAll(/\[[^\]]+\]\(([^)]+)\)/gu)) {
        const target = match[1].split("#", 1)[0];
        if (target === "" || /^(?:https?:|mailto:)/u.test(target)) continue;
        expect(existsSync(resolve(directory, target)), `${relativePath} -> ${target}`).toBe(true);
      }
    }
  });
});
