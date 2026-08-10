import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

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
    sha256: "7154ae884070decc5ca2fb2484cf09ce5e16322cc6a176ea9509a2347d815bed",
    fileCount: 38,
  },
  {
    path: "packages/theme-402v",
    name: "@402v/theme-402v",
    version: "0.1.0",
    tarball: "402v-theme-402v-0.1.0.tgz",
    sha256: "144c9de1b6a8146c1ac321a41ef2a72a7ea7678326d74b684bcaa835307acab4",
    fileCount: 6,
  },
  {
    path: "packages/cli",
    name: "@402v/html-kit-cli",
    version: "0.1.0",
    tarball: "402v-html-kit-cli-0.1.0.tgz",
    sha256: "18662c622a6b49ad11b5a9a1881af860a1565bfba2e12af891fd4df9adc02a95",
    fileCount: 5,
  },
] as const;

type ReleaseEvidence = {
  schemaVersion: 1;
  releaseVersion: string;
  commits: { baseline: string; oss: string; siteIntegration: string };
  testTotals: {
    baseline: { files: number; tests: number };
    oss: { files: number; tests: number };
    site: { files: number; passed: number; skipped: number };
  };
  packages: Array<{
    path: string;
    name: string;
    version: string;
    tarball: string;
    sha256: string;
    fileCount: number;
  }>;
  frozenV1: Record<string, string>;
  examples: typeof expectedExamples;
  sitePublisher: { bytes: number; sha256: string; focusedTests: number };
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
  environment: Record<string, string> = {},
) {
  return spawnSync(executable, [...args], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CI: "true",
      NODE_PATH: "",
      NO_COLOR: "1",
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false",
      ...environment,
    },
    timeout,
  });
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
        const result = spawnSync(process.execPath, [cli, ...args], {
          cwd: join(root, directory),
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_PATH: "",
            NO_COLOR: "1",
            npm_config_offline: "true",
            npm_config_update_notifier: "false",
          },
          timeout: 30_000,
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

function packSha256s() {
  const root = mkdtempSync(join(tmpdir(), "402v-rc-acceptance-pack-"));
  const cache = join(root, "npm-cache");
  mkdirSync(cache);
  try {
    for (const packageDefinition of expectedPackages) {
      const npmCli = process.env.npm_execpath;
      const executable = npmCli === undefined ? "npm" : process.execPath;
      const prefix = npmCli === undefined ? [] : [npmCli];
      const result = spawnSync(
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
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_PATH: "",
            NO_COLOR: "1",
            npm_config_cache: cache,
            npm_config_offline: "true",
            npm_config_update_notifier: "false",
          },
          timeout: 30_000,
        },
      );
      expectSuccess(result);
    }
    return expectedPackages.map(({ tarball }) => ({
      tarball,
      sha256: createHash("sha256")
        .update(readFileSync(join(root, tarball)))
        .digest("hex"),
    }));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function listedTestTotals() {
  const result = run(
    process.execPath,
    [join(workspaceRoot, "node_modules/vitest/vitest.mjs"), "list", "--json"],
    30_000,
  );
  expectSuccess(result);
  const tests = JSON.parse(result.stdout) as Array<{ file: string; name: string }>;
  return { files: new Set(tests.map(({ file }) => file)).size, tests: tests.length };
}

describe.sequential("local release candidate acceptance", () => {
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
      expect.objectContaining({ name: "@402v/html-kit-cli", fileCount: 5 }),
      expect.objectContaining({ name: "@402v/html-kit-core", fileCount: 38 }),
      expect.objectContaining({ name: "@402v/theme-402v", fileCount: 6 }),
    ]);
    expect(packSha256s()).toEqual(
      expectedPackages.map(({ tarball, sha256 }) => ({ tarball, sha256 })),
    );
  }, 190_000);

  it("has no cached production high or critical advisory", () => {
    const npmCli = process.env.npm_execpath;
    const result = npmCli
      ? run(process.execPath, [npmCli, "audit", "--omit=dev", "--json", "--offline"], 30_000)
      : run("npm", ["audit", "--omit=dev", "--json", "--offline"], 30_000);
    expectSuccess(result);
    const report = JSON.parse(result.stdout);
    expect(report.metadata.vulnerabilities.high).toBe(0);
    expect(report.metadata.vulnerabilities.critical).toBe(0);
  }, 40_000);

  it("records every bounded release evidence field", () => {
    expect(existsSync(checklistPath), "docs/release-checklist.md is missing").toBe(true);
    const checklist = readFileSync(checklistPath, "utf8");
    const evidence = parseEvidence(checklist);
    const manifests = packagePaths.map((path) => ({
      path: path.replace("/package.json", ""),
      manifest: JSON.parse(read(path)) as { name: string; version: string },
    }));
    expect(evidence).toMatchObject({
      schemaVersion: 1,
      releaseVersion: "0.1.0",
      commits: {
        baseline: "9527b4fd8c3ff3c49180516440f715a6d1798c8f",
        oss: "59f01074c7daca6de38e30550fea2ca4335d0eff",
        siteIntegration: "f7b2a60c522f3cba48168de8a70e5642ef58fab2",
      },
      testTotals: {
        baseline: { files: 105, tests: 703 },
        oss: { files: 23, tests: 393 },
        site: { files: 96, passed: 524, skipped: 1 },
      },
      frozenV1: frozenFixtures,
      examples: expectedExamples,
      sitePublisher: {
        bytes: 16_084,
        sha256: frozenFixtures["tests/compatibility/fixtures/v1/note.html"],
        focusedTests: 14,
      },
    });
    expect(evidence.packages).toEqual(expectedPackages);
    expect(evidence.packages.map(({ path, name, version }) => ({ path, name, version })))
      .toEqual(manifests.map(({ path, manifest: { name, version } }) => ({
        path,
        name,
        version,
      })));
    expect(evidence.testTotals.oss).toEqual(listedTestTotals());
    expect(readFileSync(join(workspaceRoot, "tests/compatibility/fixtures/v1/note.html")))
      .toHaveLength(evidence.sitePublisher.bytes);
    for (const required of [
      "9527b4fd8c3ff3c49180516440f715a6d1798c8f",
      "59f01074c7daca6de38e30550fea2ca4335d0eff",
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
  }, 30_000);
});
