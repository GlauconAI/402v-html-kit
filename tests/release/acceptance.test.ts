import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  controlledNpmEnvironment,
  hashTarballContents,
  sanitizedEnvironment,
} from "../package-smoke/pack-smoke.mjs";

const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const checklistPath = join(workspaceRoot, "docs/release-checklist.md");
const packagePaths = [
  "packages/core/package.json",
  "packages/theme-402v/package.json",
  "packages/cli/package.json",
] as const;
const frozenFixtures = {
  "tests/compatibility/fixtures/v1/interactive.html":
    "56763f265a8616c3a305727adcf6a8fd901ccf77e4d214aebf5b11d47bff51a0",
  "tests/compatibility/fixtures/v1/note.html":
    "d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056",
} as const;
const expectedExamples = {
  note: {
    bytes: 16_351,
    sha256: "496947be80e64d446fde0a5fe998a5e132de7f6043dacc07946f55ce4b13b6bc",
  },
  interactive: {
    bytes: 16_585,
    sha256: "80cc0e39f90d06dc78409895e6ffa7098a70e44406f596164d75a97ab27705b2",
  },
  customTheme: {
    bytes: 1_596,
    sha256: "f40ec6a6b02e6c75d06f94edb26f90646e0812548f1050d6b2e9a645001ec7aa",
  },
} as const;
const expectedPackages = [
  {
    path: "packages/core",
    name: "@402v/html-kit-core",
    version: "0.1.0",
    tarball: "402v-html-kit-core-0.1.0.tgz",
    contentsSha256: "69b898c391a39c9e324cef4583c4b60e2e224a2c46634d06e15a35e7cb9b45e5",
    fileCount: 38,
  },
  {
    path: "packages/theme-402v",
    name: "@402v/theme-402v",
    version: "0.1.0",
    tarball: "402v-theme-402v-0.1.0.tgz",
    contentsSha256: "5bccf7adf1f2352a7795d2cdca3c0026de950031b6123bed8c4be556c288a8da",
    fileCount: 6,
  },
  {
    path: "packages/cli",
    name: "@402v/html-kit-cli",
    version: "0.1.0",
    tarball: "402v-html-kit-cli-0.1.0.tgz",
    contentsSha256: "36c2404f64690510caf6d1c6236c86aafd1d14bfa3f12a12b6eb1cb5c82de8d2",
    fileCount: 7,
  },
] as const;

type ReleaseEvidence = {
  schemaVersion: 5;
  releaseVersion: string;
  commits: { baseline: string; oss: string; siteIntegration: string };
  testTotals: {
    baseline: { files: number; tests: number };
    oss: { files: number; packageCiTests: number; localRcTests: number };
    site: { files: number; passed: number; skipped: number };
  };
  packages: Array<{
    path: string;
    name: string;
    version: string;
    tarball: string;
    contentsSha256: string;
    fileCount: number;
  }>;
  frozenV1: Record<string, string>;
  examples: typeof expectedExamples;
  sitePublisher: {
    gate: "required-with-HTML_KIT_SITE_WORKTREE";
    tree: string;
    bytes: number;
    sha256: string;
    focusedTests: number;
  };
  productionAudit: {
    command: "npm audit --omit=dev --json";
    observedAt: string;
    packageLockSha256: string;
    high: number;
    critical: number;
    total: number;
  };
};

function read(relativePath: string) {
  return readFileSync(join(workspaceRoot, relativePath), "utf8");
}

function sha256(relativePath: string) {
  return createHash("sha256")
    .update(readFileSync(join(workspaceRoot, relativePath)))
    .digest("hex");
}

function run(
  executable: string,
  args: readonly string[],
  timeout: number,
  options: {
    cwd?: string;
    inheritedEnvironment?: NodeJS.ProcessEnv;
    offline?: boolean;
    seedProductionCache?: boolean;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "402v-rc-child-env-"));
  const cache = join(root, "npm-cache");
  const prefix = join(root, "npm-prefix");
  const userConfig = join(root, "user.npmrc");
  const globalConfig = join(root, "global.npmrc");
  mkdirSync(cache);
  mkdirSync(prefix);
  writeFileSync(userConfig, "");
  writeFileSync(globalConfig, "");
  try {
    if (options.seedProductionCache === true) seedProductionCache(cache);
    const environment = {
      ...sanitizedEnvironment(options.inheritedEnvironment ?? process.env),
      ...controlledNpmEnvironment({
        cache,
        globalConfig,
        ignoreScripts: true,
        offline: options.offline ?? true,
        prefix,
        userConfig,
      }),
      NO_COLOR: "1",
    };
    return spawnSync(executable, [...args], {
      cwd: options.cwd ?? workspaceRoot,
      encoding: "utf8",
      env: environment,
      timeout,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function cacheContentPath(cacheRoot: string, integrity: string) {
  const match = integrity.match(/^([a-z0-9]+)-(.+)$/iu);
  if (match === null) throw new Error(`Unsupported lock integrity: ${integrity}`);
  const hex = Buffer.from(match[2], "base64").toString("hex");
  return join(
    cacheRoot,
    "_cacache",
    "content-v2",
    match[1],
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
}

function seedProductionCache(destinationRoot: string) {
  const canonical = sanitizedEnvironment() as Record<string, string | undefined>;
  const sourceRoot = process.platform === "win32"
    ? join(canonical.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "npm-cache")
    : join(canonical.HOME ?? homedir(), ".npm");
  const lock = JSON.parse(read("package-lock.json")) as {
    packages: Record<string, { dev?: boolean; integrity?: string; optional?: boolean }>;
  };
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (
      !path.startsWith("node_modules/") ||
      path.startsWith("node_modules/@402v/") ||
      entry.dev === true ||
      entry.integrity === undefined
    ) {
      continue;
    }
    const source = cacheContentPath(sourceRoot, entry.integrity);
    if (!existsSync(source)) {
      if (entry.optional === true) continue;
      throw new Error(`Required production tarball is absent from the npm cache: ${path}`);
    }
    const destination = cacheContentPath(destinationRoot, entry.integrity);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function expectSuccess(result: ReturnType<typeof spawnSync>) {
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function parseEvidence(checklist: string): ReleaseEvidence {
  const match = checklist.match(
    /<!-- release-evidence:start -->\s*```json\s*([\s\S]*?)\s*```\s*<!-- release-evidence:end -->/u,
  );
  expect(match, "release checklist lacks its machine-readable evidence block").not.toBeNull();
  return JSON.parse(match![1]) as ReleaseEvidence;
}

function buildExampleHashes() {
  const root = mkdtempSync(join(tmpdir(), "402v-rc-acceptance-examples-"));
  const cli = join(workspaceRoot, "packages/cli/src/cli.mjs");
  try {
    for (const directory of ["note", "interactive", "custom-theme"]) {
      mkdirSync(join(root, directory));
    }
    for (const [directory, files] of Object.entries({
      note: ["input.md"],
      interactive: ["artifact.mjs", "data.json", "renderer.mjs"],
      "custom-theme": ["artifact-theme.mjs", "input.md"],
    })) {
      for (const file of files) {
        copyFileSync(
          join(workspaceRoot, "examples", directory, file),
          join(root, directory, file),
        );
      }
    }
    const cases = [
      {
        key: "note",
        directory: "note",
        args: ["build", "input.md", "--output", "output.html"],
      },
      {
        key: "interactive",
        directory: "interactive",
        args: ["build-artifact", "artifact.mjs", "--output", "output.html"],
      },
      {
        key: "customTheme",
        directory: "custom-theme",
        args: [
          "build",
          "input.md",
          "--theme",
          "./artifact-theme.mjs",
          "--output",
          "output.html",
        ],
      },
    ] as const;
    return Object.fromEntries(
      cases.map(({ key, directory, args }) => {
        const result = run(process.execPath, [cli, ...args], 30_000, {
          cwd: join(root, directory),
        });
        expectSuccess(result);
        const output = readFileSync(join(root, directory, "output.html"));
        return [
          key,
          {
            bytes: output.byteLength,
            sha256: createHash("sha256").update(output).digest("hex"),
          },
        ];
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function packContentsSha256s() {
  const root = mkdtempSync(join(tmpdir(), "402v-rc-acceptance-pack-"));
  try {
    for (const packageDefinition of expectedPackages) {
      const npmCli = process.env.npm_execpath;
      const executable = npmCli === undefined ? "npm" : process.execPath;
      const prefix = npmCli === undefined ? [] : [npmCli];
      const result = run(
        executable,
        [
          ...prefix,
          "pack",
          "--json",
          "--ignore-scripts",
          "--workspace",
          packageDefinition.name,
          "--pack-destination",
          root,
        ],
        30_000,
      );
      expectSuccess(result);
    }
    return expectedPackages.map(({ tarball }) => ({
      tarball,
      contentsSha256: hashTarballContents(
        readFileSync(join(root, tarball)),
        "sha256",
      ).toString("hex"),
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function listedTestTotals() {
  const result = run(
    process.execPath,
    [join(workspaceRoot, "node_modules/vitest/vitest.mjs"), "list", "--json"],
    120_000,
  );
  expectSuccess(result);
  const tests = JSON.parse(result.stdout) as Array<{ file: string; name: string }>;
  return { files: new Set(tests.map(({ file }) => file)).size, tests: tests.length };
}

describe.sequential("local release candidate acceptance", () => {
  it("rejects inherited preload and npm resolution configuration", () => {
    const root = mkdtempSync(join(tmpdir(), "402v-rc-preload-red-"));
    const preload = join(root, "preload.cjs");
    const marker = join(root, "injected");
    writeFileSync(preload, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "injected")`);
    try {
      const result = run(process.execPath, ["-e", ""], 10_000, {
        inheritedEnvironment: {
          ...process.env,
          INIT_CWD: "/host/init-must-not-propagate",
          NODE_OPTIONS: `--require=${preload}`,
          NODE_PATH: "/host/modules-must-not-resolve",
          npm_config_userconfig: "/host/config-must-not-be-used",
        },
      });
      expectSuccess(result);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.env.HTML_KIT_SITE_WORKTREE === undefined)(
    "requires the exact local site integration worktree",
    () => {
      const siteWorktree = realpathSync(process.env.HTML_KIT_SITE_WORKTREE!);
      expect(existsSync(join(siteWorktree, "package.json"))).toBe(true);

      const head = run("git", ["rev-parse", "HEAD"], 10_000, { cwd: siteWorktree });
      const tree = run("git", ["rev-parse", "HEAD^{tree}"], 10_000, {
        cwd: siteWorktree,
      });
      const status = run(
        "git",
        ["status", "--porcelain=v1", "--untracked-files=all"],
        10_000,
        { cwd: siteWorktree },
      );
      for (const result of [head, tree, status]) expectSuccess(result);
      expect(head.stdout.trim()).toBe(
        "f7b2a60c522f3cba48168de8a70e5642ef58fab2",
      );
      expect(tree.stdout.trim()).toBe("31b0b196aaa0a107602e0f9a5e3bcf53d456c27f");
      expect(status.stdout).toBe("");

      const focused = run(
        process.execPath,
        [
          join(siteWorktree, "node_modules/vitest/vitest.mjs"),
          "run",
          "tests/publish-html-cli.test.ts",
        ],
        60_000,
        { cwd: siteWorktree },
      );
      expectSuccess(focused);
      expect(focused.stdout).toMatch(/Test Files\s+1 passed/u);
      expect(focused.stdout).toMatch(/Tests\s+14 passed/u);

      const inputPath = join(siteWorktree, "tests/fixtures/standalone-v1.html");
      const input = readFileSync(inputPath);
      const publisher = run(
        process.execPath,
        [
          "scripts/publish-html.mjs",
          "--input",
          inputPath,
          "--title",
          "RC cross-repository proof",
          "--slug",
          "rc-cross-repository-proof",
          "--author-id",
          "00000000-0000-0000-0000-000000000001",
          "--dry-run",
        ],
        30_000,
        { cwd: siteWorktree },
      );
      expectSuccess(publisher);
      expect(publisher.stderr).toBe("");
      const payload = JSON.parse(publisher.stdout) as { content_html: string };
      const published = Buffer.from(payload.content_html, "utf8");
      expect(published).toEqual(input);
      expect(published.byteLength).toBe(16_084);
      expect(createHash("sha256").update(published).digest("hex")).toBe(
        "d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056",
      );
    },
    120_000,
  );

  it("has matching package versions recorded in the changelog", () => {
    const versions = packagePaths.map(
      (path) => JSON.parse(read(path)).version as string,
    );
    expect(new Set(versions)).toEqual(new Set(["0.1.0"]));
    expect(read("CHANGELOG.md")).toContain(`## [${versions[0]}]`);
  });

  it("matches both frozen contract-v1 fixture hashes to provenance", () => {
    const provenance = read("docs/provenance.md");
    for (const [path, expectedHash] of Object.entries(frozenFixtures)) {
      expect(sha256(path)).toBe(expectedHash);
      expect(provenance).toContain(`${expectedHash}  ${path}`);
    }
  });

  it("proves contract-v1 mutation rejection and explicit upgrade behavior", () => {
    const result = run(
      process.execPath,
      [
        join(workspaceRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "tests/compatibility",
      ],
      60_000,
    );
    expectSuccess(result);
    expect(result.stdout).toMatch(/Test Files\s+2 passed/u);
    expect(result.stdout).toMatch(/Tests\s+5 passed/u);
  }, 70_000);

  it("builds and verifies all three contract-v2 examples from packed packages", () => {
    const result = run(
      process.execPath,
      [
        join(workspaceRoot, "node_modules/vitest/vitest.mjs"),
        "run",
        "tests/browser/examples.test.ts",
        "--testNamePattern",
        "builds and verifies every example twice with identical bytes",
      ],
      180_000,
      { seedProductionCache: true },
    );
    expectSuccess(result);
    expect(result.stdout).toMatch(/1 passed\s*\|\s*10 skipped/u);
    expect(buildExampleHashes()).toEqual(expectedExamples);
  }, 190_000);

  it("passes packed clean-consumer, boundary, license, and forbidden scans", () => {
    const result = run(
      process.execPath,
      [join(workspaceRoot, "tests/package-smoke/pack-smoke.mjs")],
      180_000,
    );
    expectSuccess(result);
    const summary = JSON.parse(result.stdout.trim());
    expect(summary).toMatchObject({
      ok: true,
      binaryExecutable: true,
      commands: ["note", "build-artifact", "verify", "update-data"],
      productionLicenseCount: 148,
    });
    expect(summary.packages).toEqual([
      expect.objectContaining({ name: "@402v/html-kit-cli", fileCount: 7 }),
      expect.objectContaining({ name: "@402v/html-kit-core", fileCount: 38 }),
      expect.objectContaining({ name: "@402v/theme-402v", fileCount: 6 }),
    ]);
    expect(packContentsSha256s()).toEqual(
      expectedPackages.map(({ tarball, contentsSha256 }) => ({
        tarball,
        contentsSha256,
      })),
    );
  }, 190_000);

  it("records every bounded release evidence field", () => {
    expect(existsSync(checklistPath), "docs/release-checklist.md is missing").toBe(true);
    const checklist = readFileSync(checklistPath, "utf8");
    const evidence = parseEvidence(checklist);
    const manifests = packagePaths.map((path) => ({
      path: path.replace("/package.json", ""),
      manifest: JSON.parse(read(path)) as { name: string; version: string },
    }));
    expect(evidence).toMatchObject({
      schemaVersion: 5,
      releaseVersion: "0.1.0",
      commits: {
        baseline: "9527b4fd8c3ff3c49180516440f715a6d1798c8f",
        oss: "fe86990674d2327c53b4dc4f4b234bed70e27d33",
        siteIntegration: "f7b2a60c522f3cba48168de8a70e5642ef58fab2",
      },
      testTotals: {
        baseline: { files: 105, tests: 703 },
        oss: { files: 24, packageCiTests: 397, localRcTests: 398 },
        site: { files: 96, passed: 524, skipped: 1 },
      },
      frozenV1: frozenFixtures,
      examples: expectedExamples,
      sitePublisher: {
        gate: "required-with-HTML_KIT_SITE_WORKTREE",
        tree: "31b0b196aaa0a107602e0f9a5e3bcf53d456c27f",
        bytes: 16_084,
        sha256: frozenFixtures["tests/compatibility/fixtures/v1/note.html"],
        focusedTests: 14,
      },
      productionAudit: {
        command: "npm audit --omit=dev --json",
        observedAt: "2026-08-11T23:21:14Z",
        packageLockSha256:
          "e525fd2bcc97ea6e4efec4c901c2890e515daf16a371e209c49654b89d4ef6dc",
        high: 0,
        critical: 0,
        total: 0,
      },
    });
    expect(evidence.packages).toEqual(expectedPackages);
    expect(evidence.packages.map(({ path, name, version }) => ({ path, name, version })))
      .toEqual(manifests.map(({ path, manifest: { name, version } }) => ({
        path,
        name,
        version,
      })));
    const listed = listedTestTotals();
    expect({
      files: evidence.testTotals.oss.files,
      tests: evidence.testTotals.oss.packageCiTests,
    }).toEqual(listed);
    expect(evidence.testTotals.oss.localRcTests).toBe(listed.tests + 1);
    expect(sha256("package-lock.json")).toBe(evidence.productionAudit.packageLockSha256);
    expect(Number.isNaN(Date.parse(evidence.productionAudit.observedAt))).toBe(false);
    for (const workflow of [
      read(".github/workflows/ci.yml"),
      read(".github/workflows/release.yml"),
    ]) {
      expect(workflow.match(/run: npm audit --omit=dev/gu)).toHaveLength(1);
    }
    expect(checklist).not.toMatch(/cached\/offline production audit|npm audit[^`\n]*--offline/iu);
    for (const required of [
      "9527b4fd8c3ff3c49180516440f715a6d1798c8f",
      "fe86990674d2327c53b4dc4f4b234bed70e27d33",
      "f7b2a60c522f3cba48168de8a70e5642ef58fab2",
      "105 test files / 703 tests",
      "npm run typecheck",
      "npm run pack:check",
      "npm audit --omit=dev",
      "contract-v1 mutation rejection",
      "explicit contract-v1 upgrade",
      "16,084 bytes",
      frozenFixtures["tests/compatibility/fixtures/v1/note.html"],
      "Rollback",
    ]) {
      expect(checklist).toContain(required);
    }
    for (const path of packagePaths) {
      expect(checklist).toContain(path.replace("/package.json", ""));
    }
  }, 150_000);
});
