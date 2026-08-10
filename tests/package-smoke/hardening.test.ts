import { spawn } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const smokeScript = fileURLToPath(new URL("./pack-smoke.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const smoke = await import("./pack-smoke.mjs") as Record<string, any>;

function inspect(source: string | Buffer, options: Record<string, unknown> = {}) {
  return smoke.inspectPublishedText({
    packageName: "@402v/html-kit-core",
    path: "src/probe.mjs",
    content: Buffer.isBuffer(source) ? source : Buffer.from(source),
    ...options,
  });
}

async function waitUntil(check: () => boolean, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for probe state");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function processExists(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cleanupProbe(mode: "signal" | "timeout", signal: NodeJS.Signals = "SIGTERM") {
  const testRoot = mkdtempSync(join(tmpdir(), "402v-cleanup-test-"));
  temporaryRoots.push(testRoot);
  const probeParent = join(testRoot, "probe-roots");
  const readyPath = join(testRoot, "ready.json");
  mkdirSync(probeParent);
  const child = spawn(process.execPath, [smokeScript, "--cleanup-probe"], {
    env: {
      ...process.env,
      PACK_SMOKE_PROBE_PARENT: probeParent,
      PACK_SMOKE_PROBE_READY: readyPath,
      PACK_SMOKE_GLOBAL_TIMEOUT_MS: "350",
    },
    stdio: "ignore",
  });
  try {
    await waitUntil(() => existsSync(readyPath));
    const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
      childPid: number;
      grandchildPid: number;
      root: string;
    };
    expect(ready.childPid).toBeGreaterThan(0);
    expect(ready.grandchildPid).toBeGreaterThan(0);
    const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve, reject) => {
        child.once("error", reject);
        child.once("exit", (code, signal) => resolve({ code, signal }));
      },
    );
    if (mode === "signal") child.kill(signal);
    const result = await exit;
    expect(
      result.code === 124 ||
      result.code === 130 ||
      result.code === 143 ||
      result.signal === "SIGINT" ||
      result.signal === "SIGTERM",
    ).toBe(true);
    await waitUntil(() => !processExists(ready.childPid));
    await waitUntil(() => !processExists(ready.grandchildPid));
    expect(existsSync(ready.root)).toBe(false);
    expect(readdirSync(probeParent)).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}

afterAll(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("package boundary hardening", () => {
  it("exports independently testable boundary helpers", () => {
    for (const name of [
      "binaryCommandArguments",
      "hashArchive",
      "inspectPublishedText",
      "installedBinaryPlan",
      "sanitizedEnvironment",
      "validatePackFilename",
      "verifyArchiveIntegrity",
      "verifyWindowsCmdShim",
    ]) {
      expect(smoke[name], name).toBeTypeOf("function");
    }
  });

  it.each([
    ["case-insensitive Next public", 'const value = "next_public_TOKEN";'],
    ["escaped 402v host", 'const value = "\\x34\\x30\\x32v\\u002ecom";'],
    ["concatenated 402v host", 'const left = "402"; const value = left + "v.com";'],
    ["escaped Supabase", 'const value = "Sup\\u0061base";'],
    ["concatenated Vercel", 'const left = "Ver"; const value = left + "cel";'],
    ["home path containing spaces", 'const value = "/Users/Review User/project";'],
    ["bare private home path", 'const value = "/Users/glaucon";'],
    ["generic absolute path containing spaces", 'const value = "/opt/Review User/project";'],
    ["escaped home path", 'const value = "\\x2fUsers\\x2fReview User\\x2fproject";'],
    ["Windows home path containing spaces", 'const value = "C:\\\\Users\\\\Review User\\\\project";'],
    ["generic Windows absolute path", 'const value = "D:\\\\Build Root\\\\private\\\\file";'],
    ["dollar credential", 'const password = "$supersecret";'],
    [
      "concatenated dollar credential",
      'const prefix = "$super"; const password = prefix + "secret";',
    ],
  ])("rejects %s", (_label, source) => {
    expect(() => inspect(source)).toThrow();
  });

  it("decodes JSON string escapes without executing package code", () => {
    expect(() => inspect('{"url":"402v\\u002ecom"}', { path: "package.json" })).toThrow();
  });

  it("parses package JavaScript without evaluating it", () => {
    delete (globalThis as Record<string, unknown>).__packSmokeExecuted;
    inspect("globalThis.__packSmokeExecuted = true;");
    expect((globalThis as Record<string, unknown>).__packSmokeExecuted).toBeUndefined();
  });

  it("rejects malformed UTF-8 instead of replacing invalid bytes", () => {
    expect(() => inspect(Buffer.from([0xc3, 0x28]))).toThrow(/UTF-8/);
  });

  it("allows an explicit credential interpolation placeholder", () => {
    expect(() => inspect('const password = "${PASSWORD}";')).not.toThrow();
  });

  it("allows only the two exact official-theme brand anchors", () => {
    const anchor = '<a class="artifact-brand" href="https://402v.com">402v</a>';
    expect(() => inspect(`export const shell = \`${anchor}\`;`, {
      packageName: "@402v/theme-402v",
      path: "src/note-shell.mjs",
    })).not.toThrow();
    expect(() => inspect(`export const shell = \`${anchor}${anchor}\`;`, {
      packageName: "@402v/theme-402v",
      path: "src/note-shell.mjs",
    })).toThrow();
    expect(() => inspect(`export const shell = \`${anchor}\`;`, {
      packageName: "@402v/theme-402v",
      path: "src/styles.mjs",
    })).toThrow();
  });

  it("builds injectable direct and Windows installed-binary plans", () => {
    expect(smoke.installedBinaryPlan({
      binaryBase: "/tmp/consumer/node_modules/.bin/402v-html-kit",
      packageEntry: "/tmp/consumer/node_modules/@402v/html-kit-cli/src/cli.mjs",
      platform: "darwin",
      nodeExecutable: "/usr/bin/node",
    })).toEqual(expect.objectContaining({
      executable: "/tmp/consumer/node_modules/.bin/402v-html-kit",
      prefixArgs: [],
      shimPath: "/tmp/consumer/node_modules/.bin/402v-html-kit",
    }));
    const windows = smoke.installedBinaryPlan({
      binaryBase: "C:\\Review User\\consumer\\node_modules\\.bin\\402v-html-kit",
      packageEntry: "C:\\Review User\\consumer\\node_modules\\@402v\\html-kit-cli\\src\\cli.mjs",
      platform: "win32",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
    });
    expect(windows).toEqual(expect.objectContaining({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      prefixArgs: ["C:\\Review User\\consumer\\node_modules\\@402v\\html-kit-cli\\src\\cli.mjs"],
      shimPath: "C:\\Review User\\consumer\\node_modules\\.bin\\402v-html-kit.cmd",
      verifiesCmdShim: true,
    }));
    expect(smoke.binaryCommandArguments(windows, ["build", "note & data.md"])).toEqual([
      "C:\\Review User\\consumer\\node_modules\\@402v\\html-kit-cli\\src\\cli.mjs",
      "build",
      "note & data.md",
    ]);
    expect(() => smoke.verifyWindowsCmdShim(Buffer.from(
      '@echo off\r\n"%dp0%\\..\\@402v\\html-kit-cli\\src\\cli.mjs" %*\r\n',
    ))).not.toThrow();
    expect(() => smoke.verifyWindowsCmdShim(Buffer.from(
      '@echo off\r\n"C:\\host\\cli.mjs" %*\r\n',
    ))).toThrow();
  });

  it("removes resolution-affecting inherited environment variables", () => {
    expect(smoke.sanitizedEnvironment({
      HOME: "/safe/home",
      NODE_OPTIONS: "--require=/tmp/host-hook.cjs",
      NODE_PATH: "/tmp/host-modules",
      npm_config_registry: "https://private.invalid",
      NPM_CONFIG_CACHE: "/tmp/host-cache",
      PATH: "/usr/bin",
      YARN_GLOBAL_FOLDER: "/tmp/yarn",
    }, {
      NODE_OPTIONS: "--require=/tmp/override-hook.cjs",
      npm_config_cache: "/tmp/private-cache",
    })).toEqual(expect.objectContaining({
      HOME: "/safe/home",
      PATH: "/usr/bin",
      npm_config_cache: "/tmp/private-cache",
    }));
    expect(smoke.sanitizedEnvironment({}, { NODE_OPTIONS: "bad" })).not.toHaveProperty(
      "NODE_OPTIONS",
    );
    const clean = smoke.sanitizedEnvironment({
      NODE_OPTIONS: "bad",
      NODE_PATH: "bad",
      npm_config_registry: "bad",
      NPM_CONFIG_CACHE: "bad",
      YARN_GLOBAL_FOLDER: "bad",
    });
    expect(clean).not.toHaveProperty("NODE_OPTIONS");
    expect(clean).not.toHaveProperty("NODE_PATH");
    expect(clean).not.toHaveProperty("npm_config_registry");
    expect(clean).not.toHaveProperty("NPM_CONFIG_CACHE");
    expect(clean).not.toHaveProperty("YARN_GLOBAL_FOLDER");
  });

  it("validates canonical pack filenames and independent archive integrity", () => {
    const archive = Buffer.from("archive bytes");
    const integrity = `sha512-${smoke.hashArchive(archive, "sha512").toString("base64")}`;
    expect(() => smoke.validatePackFilename({
      filename: "402v-html-kit-core-0.1.0.tgz",
      name: "@402v/html-kit-core",
      tarballRoot: "/tmp/tarballs",
      version: "0.1.0",
    })).not.toThrow();
    expect(() => smoke.validatePackFilename({
      filename: "../402v-html-kit-core-0.1.0.tgz",
      name: "@402v/html-kit-core",
      tarballRoot: "/tmp/tarballs",
      version: "0.1.0",
    })).toThrow();
    expect(() => smoke.verifyArchiveIntegrity(archive, integrity)).not.toThrow();
    expect(() => smoke.verifyArchiveIntegrity(Buffer.from("altered"), integrity)).toThrow();
  });

  it("cleans the exact temporary root and child after a global timeout", async () => {
    await cleanupProbe("timeout");
  }, 15_000);

  it("cleans the exact temporary root and child after SIGTERM", async () => {
    await cleanupProbe("signal", "SIGTERM");
  }, 15_000);

  it("cleans the exact temporary root and child after SIGINT", async () => {
    await cleanupProbe("signal", "SIGINT");
  }, 15_000);
});
