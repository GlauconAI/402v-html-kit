import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
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
import { gzipSync } from "node:zlib";

import { afterAll, describe, expect, it } from "vitest";

const smokeScript = fileURLToPath(new URL("./pack-smoke.mjs", import.meta.url));
const temporaryRoots: string[] = [];
const smoke = await import("./pack-smoke.mjs") as Record<string, any>;

function tarballWithMetadata({
  content,
  modifiedAt,
  user,
}: {
  content: string;
  modifiedAt: number;
  user: string;
}) {
  const header = Buffer.alloc(512);
  const writeString = (offset: number, length: number, value: string) => {
    header.write(value, offset, Math.min(length, Buffer.byteLength(value)), "utf8");
  };
  const writeOctal = (offset: number, length: number, value: number) => {
    writeString(offset, length, `${value.toString(8).padStart(length - 1, "0")}\0`);
  };
  const body = Buffer.from(content);
  writeString(0, 100, "package/example.txt");
  writeOctal(100, 8, 0o644);
  writeOctal(108, 8, 501);
  writeOctal(116, 8, 20);
  writeOctal(124, 12, body.length);
  writeOctal(136, 12, modifiedAt);
  header.fill(32, 148, 156);
  writeString(156, 1, "0");
  writeString(257, 6, "ustar\0");
  writeString(263, 2, "00");
  writeString(265, 32, user);
  writeString(297, 32, "staff");
  const checksum = header.reduce((total, byte) => total + byte, 0);
  writeString(148, 8, `${checksum.toString(8).padStart(6, "0")}\0 `);
  const padding = Buffer.alloc(Math.ceil(body.length / 512) * 512 - body.length);
  return gzipSync(Buffer.concat([header, body, padding, Buffer.alloc(1024)]));
}

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

async function cleanupProbe(
  mode: "leader-exit" | "output-limit" | "signal" | "timeout",
  signal: NodeJS.Signals = "SIGTERM",
) {
  const testRoot = mkdtempSync(join(tmpdir(), "402v-cleanup-test-"));
  temporaryRoots.push(testRoot);
  const probeParent = join(testRoot, "probe-roots");
  const readyPath = join(testRoot, "ready.json");
  const termMarker = join(testRoot, "grandchild-term.txt");
  mkdirSync(probeParent);
  const unrelated = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  const unrelatedExit = new Promise<void>((resolve) => unrelated.once("exit", () => resolve()));
  const child = spawn(process.execPath, [smokeScript, "--cleanup-probe"], {
    env: {
      ...process.env,
      PACK_SMOKE_PROBE_MODE: mode,
      PACK_SMOKE_PROBE_PARENT: probeParent,
      PACK_SMOKE_PROBE_READY: readyPath,
      PACK_SMOKE_PROBE_TERM_MARKER: termMarker,
      PACK_SMOKE_GLOBAL_TIMEOUT_MS: mode === "output-limit" ? "5000" : "1500",
    },
    stdio: "ignore",
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
  try {
    await waitUntil(() => existsSync(readyPath));
    const ready = JSON.parse(readFileSync(readyPath, "utf8")) as {
      childPid: number;
      grandchildPid: number;
      root: string;
    };
    expect(ready.childPid).toBeGreaterThan(0);
    expect(ready.grandchildPid).toBeGreaterThan(0);
    if (mode === "signal") child.kill(signal);
    const result = await exit;
    expect(
      (mode === "leader-exit" && result.code === 1) ||
      result.code === 124 ||
      result.code === 130 ||
      result.code === 143 ||
      result.signal === "SIGINT" ||
      result.signal === "SIGTERM",
    ).toBe(true);
    await waitUntil(() => !processExists(ready.childPid));
    await waitUntil(() => !processExists(ready.grandchildPid));
    if (mode === "leader-exit" || mode === "output-limit") {
      if (process.platform !== "win32") {
        expect(readFileSync(termMarker, "utf8")).toBe("TERM");
      }
    }
    expect(processExists(unrelated.pid!)).toBe(true);
    expect(existsSync(ready.root)).toBe(false);
    expect(readdirSync(probeParent)).toEqual([]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill("SIGKILL");
    await unrelatedExit;
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
      "controlledNpmEnvironment",
      "hashArchive",
      "hashTarballContents",
      "inspectPublishedText",
      "installedBinaryPlan",
      "npmExecutionPlan",
      "probeWindowsInstalledShim",
      "runSmokeCommand",
      "sanitizedEnvironment",
      "assertPackedManifestMatches",
      "supervisedCommandPlan",
      "terminateWindowsSupervisor",
      "validatePackFilename",
      "verifyArchiveIntegrity",
      "verifyWindowsCmdShim",
    ]) {
      expect(smoke[name], name).toBeTypeOf("function");
    }
  });

  it("hashes package contents independently of gzip and tar metadata", () => {
    const first = tarballWithMetadata({
      content: "portable package contents",
      modifiedAt: 1,
      user: "mac-builder",
    });
    const second = tarballWithMetadata({
      content: "portable package contents",
      modifiedAt: 2,
      user: "linux-builder",
    });
    const changed = tarballWithMetadata({
      content: "changed package contents",
      modifiedAt: 2,
      user: "linux-builder",
    });

    expect(createHash("sha256").update(first).digest("hex")).not.toBe(
      createHash("sha256").update(second).digest("hex"),
    );
    expect(smoke.hashTarballContents(first, "sha256")).toEqual(
      smoke.hashTarballContents(second, "sha256"),
    );
    expect(smoke.hashTarballContents(first, "sha256")).not.toEqual(
      smoke.hashTarballContents(changed, "sha256"),
    );
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

  it.each([
    [
      "declaration literal",
      "src/probe.d.mts",
      'export declare const endpoint: "402v\\u002ecom";',
    ],
    [
      "typed module literal",
      "src/probe.mts",
      'const endpoint: string = ["Sup", "abase"].join("");',
    ],
    [
      "typed source nested constants",
      "src/probe.ts",
      'function probe() { const left: string = "Ver"; { const endpoint = left + "cel"; } }',
    ],
    [
      "nested JavaScript array join",
      "src/probe.mjs",
      'function probe() { const left = "402"; { const endpoint = [left, "v", ".com"].join(""); } }',
    ],
  ])("statically rejects %s in %s", (_label, path, source) => {
    expect(() => inspect(source, { path })).toThrow();
  });

  it("respects lexical shadowing while folding nested constants", () => {
    expect(() => inspect(
      'const left = "402"; function probe() { const left = "safe"; const endpoint = left + "v.com"; }',
    )).not.toThrow();
  });

  it.each([
    [
      "direct concatenation",
      'function probe() { const endpoint = prefix + "v.com"; } const prefix = "402";',
    ],
    [
      "array join",
      'function probe() { const endpoint = [prefix, "abase"].join(""); } const prefix = "Sup";',
    ],
  ])("resolves later outer const bindings in earlier closures for %s", (_label, source) => {
    expect(() => inspect(source)).toThrow();
  });

  it("uses later same-scope const bindings as lexical shadows", () => {
    expect(() => inspect(
      'const prefix = "402"; function probe() { const endpoint = prefix + "v.com"; const prefix = "safe"; }',
    )).not.toThrow();
    expect(() => inspect(
      'const prefix = "safe"; function probe() { const endpoint = prefix + "v.com"; const prefix = "402"; }',
    )).toThrow();
  });

  it.each([
    ["JSX", "src/probe.jsx", 'export const view = <div data-label="safe">safe</div>;'],
    ["TSX", "src/probe.tsx", 'export const view: JSX.Element = <div data-label="safe">safe</div>;'],
  ])("parses valid %s using its matching script kind", (_label, path, source) => {
    expect(() => inspect(source, { path })).not.toThrow();
  });

  it("pre-collects immutable bindings inside TypeScript namespace module blocks", () => {
    expect(() => inspect(
      'namespace Review { function probe() { const endpoint = prefix + "v.com"; } const prefix = "402"; }',
      { path: "src/probe.ts" },
    )).toThrow();
    expect(() => inspect(
      'const prefix = "402"; namespace Review { function probe() { const endpoint = prefix + "v.com"; } const prefix = "safe"; }',
      { path: "src/probe.ts" },
    )).not.toThrow();
    expect(() => inspect(
      'const prefix = "safe"; namespace Review { function probe() { const endpoint = prefix + "v.com"; } const prefix = "402"; }',
      { path: "src/probe.ts" },
    )).toThrow();
  });

  it.each([
    ["CTS", "src/probe.cts", 'const endpoint = ["Ver", "cel"].join("");'],
    ["declaration CTS", "src/probe.d.cts", 'export declare const endpoint: "402v\\u002ecom";'],
  ])("scans %s published text", (_label, path, source) => {
    expect(() => inspect(source, { path })).toThrow();
  });

  it("uses one published text extension allowlist for source and tar scanning", () => {
    expect([...smoke.publishedTextExtensions].sort()).toEqual([
      ".cjs",
      ".cts",
      ".js",
      ".json",
      ".jsx",
      ".mjs",
      ".mts",
      ".ts",
      ".tsx",
    ]);
  });

  it.each([
    ["named entity in a string", "src/probe.mjs", 'const endpoint = "402v&period;com";'],
    ["decimal entity in a JSX attribute", "src/probe.jsx", '<div data-endpoint="Sup&#97;base" />;'],
    ["hex entity in JSX text", "src/probe.tsx", '<div>Ver&#x63;el</div>;'],
  ])("decodes %s before forbidden-content checks", (_label, path, source) => {
    expect(() => inspect(source, { path })).toThrow();
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

  it("canonicalizes mixed-case Windows process environment keys", () => {
    expect(smoke.sanitizedEnvironment({
      Path: "C:\\Windows\\System32",
      pathext: ".COM;.EXE;.CMD",
      COMSPEC: "C:\\Windows\\System32\\cmd.exe",
      SYSTEMROOT: "C:\\Windows",
    })).toEqual({
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATH: "C:\\Windows\\System32",
      PATHEXT: ".COM;.EXE;.CMD",
      SystemRoot: "C:\\Windows",
    });
  });

  it("plans Windows npm through a validated CLI or ComSpec fallback", () => {
    expect(smoke.npmExecutionPlan({
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      npmExecPath: "C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js",
      platform: "win32",
    })).toEqual(expect.objectContaining({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      prefixArgs: ["C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js"],
    }));
    expect(smoke.npmExecutionPlan({
      comSpec: "C:\\Windows\\System32\\cmd.exe",
      platform: "win32",
    })).toEqual(expect.objectContaining({
      executable: "C:\\Windows\\System32\\cmd.exe",
      prefixArgs: ["/d", "/s", "/c"],
    }));
    expect(() => smoke.npmExecutionPlan({
      npmExecPath: "C:\\host\\not-npm.js",
      platform: "win32",
    })).toThrow();
  });

  it("requires an active packed target and successful JSON from fake ComSpec", async () => {
    const validShim = Buffer.from(
      '@echo off\r\n"%dp0%\\..\\@402v\\html-kit-cli\\src\\cli.mjs" %*\r\n',
    );
    const success = async () => ({ status: 0, stderr: "", stdout: '{"ok":true}\n' });
    await expect(smoke.probeWindowsInstalledShim({
      run: success,
      shimContent: validShim,
      shimPath: "C:\\consumer\\node_modules\\.bin\\402v-html-kit.cmd",
    })).resolves.toMatchObject({ ok: true });
    await expect(smoke.probeWindowsInstalledShim({
      run: success,
      shimContent: Buffer.from(
        'rem "%dp0%\\..\\@402v\\html-kit-cli\\src\\cli.mjs"\r\n@exit /b 0\r\n',
      ),
      shimPath: "C:\\consumer\\node_modules\\.bin\\402v-html-kit.cmd",
    })).rejects.toThrow();
    await expect(smoke.probeWindowsInstalledShim({
      run: async () => ({ status: 1, stderr: "failed", stdout: "" }),
      shimContent: validShim,
      shimPath: "C:\\consumer\\node_modules\\.bin\\402v-html-kit.cmd",
    })).rejects.toThrow();
    await expect(smoke.probeWindowsInstalledShim({
      run: success,
      shimContent: Buffer.from('@echo off\r\n"C:\\host\\@402v\\html-kit-cli\\src\\cli.mjs" %*\r\n'),
      shimPath: "C:\\consumer\\node_modules\\.bin\\402v-html-kit.cmd",
    })).rejects.toThrow();
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

  it("disables npm update notices in every controlled private environment", () => {
    expect(smoke.controlledNpmEnvironment({
      cache: "/tmp/private-cache",
      globalConfig: "/tmp/global.npmrc",
      ignoreScripts: true,
      offline: true,
      prefix: "/tmp/private-prefix",
      userConfig: "/tmp/user.npmrc",
    })).toEqual({
      npm_config_cache: "/tmp/private-cache",
      npm_config_globalconfig: "/tmp/global.npmrc",
      npm_config_ignore_scripts: "true",
      npm_config_loglevel: "error",
      npm_config_offline: "true",
      npm_config_prefix: "/tmp/private-prefix",
      npm_config_update_notifier: "false",
      npm_config_userconfig: "/tmp/user.npmrc",
    });
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
    const sha256 = `sha256-${smoke.hashArchive(archive, "sha256").toString("base64")}`;
    expect(() => smoke.verifyArchiveIntegrity(archive, sha256)).toThrow(/sha512/);
    expect(() => smoke.verifyArchiveIntegrity(archive, `${integrity}junk`)).toThrow();
    expect(() => smoke.verifyArchiveIntegrity(archive, integrity.slice(0, -1))).toThrow();
    expect(() => smoke.verifyArchiveIntegrity(
      archive,
      integrity.replace("sha512-", "SHA512-"),
    )).toThrow();
  });

  it("builds an injection-free persistent supervisor invocation", () => {
    const plan = smoke.supervisedCommandPlan({
      args: ["/d", "/s", "/c", '"C:\\Review User\\tool.cmd" "a & b"'],
      executable: "C:\\Windows\\System32\\cmd.exe",
      nodeExecutable: "C:\\Program Files\\nodejs\\node.exe",
      platform: "win32",
    });
    expect(plan).toEqual(expect.objectContaining({
      executable: "C:\\Program Files\\nodejs\\node.exe",
      supervised: true,
    }));
    expect(plan.args.slice(-5)).toEqual([
      "C:\\Windows\\System32\\cmd.exe",
      "/d",
      "/s",
      "/c",
      '"C:\\Review User\\tool.cmd" "a & b"',
    ]);
  });

  it("taskkills an owned Windows supervisor PID exactly once", async () => {
    const calls: Array<{ executable: string; args: string[] }> = [];
    const spawnProcess = (executable: string, args: string[]) => {
      calls.push({ executable, args });
      const killer = new EventEmitter();
      queueMicrotask(() => killer.emit("close", 0));
      return killer;
    };
    const record = { rootPid: 4242, terminating: false, terminationPromise: undefined };
    const activeRecords = new Set([record]);
    await Promise.all([
      smoke.terminateWindowsSupervisor(record, { activeRecords, spawnProcess }),
      smoke.terminateWindowsSupervisor(record, { activeRecords, spawnProcess }),
    ]);
    expect(calls).toEqual([{
      executable: "taskkill",
      args: ["/pid", "4242", "/t", "/f"],
    }]);
    expect(record.terminating).toBe(true);
    expect(activeRecords.has(record)).toBe(false);
  });

  it.each([
    ["spawn error", (killer: EventEmitter) => killer.emit("error", new Error("denied"))],
    ["nonzero exit", (killer: EventEmitter) => killer.emit("close", 1)],
  ])("retains Windows supervisor ownership after taskkill %s", async (_label, finish) => {
    const record = { rootPid: 4242, terminating: false, terminationPromise: undefined };
    const activeRecords = new Set([record]);
    const spawnProcess = () => {
      const killer = new EventEmitter();
      queueMicrotask(() => finish(killer));
      return killer;
    };
    await expect(smoke.terminateWindowsSupervisor(record, {
      activeRecords,
      spawnProcess,
      timeoutMs: 50,
    })).rejects.toThrow(/taskkill/iu);
    expect(activeRecords.has(record)).toBe(true);
    expect(record.terminating).toBe(false);
    expect(record.terminationPromise).toBeUndefined();
  });

  it("times out taskkill teardown and retains the active supervisor record", async () => {
    const record = { rootPid: 4242, terminating: false, terminationPromise: undefined };
    const activeRecords = new Set([record]);
    let killerWasStopped = false;
    const neverClosingKiller = new EventEmitter() as EventEmitter & { kill: () => void };
    neverClosingKiller.kill = () => {
      killerWasStopped = true;
    };
    const teardown = smoke.terminateWindowsSupervisor(record, {
      activeRecords,
      spawnProcess: () => neverClosingKiller,
      timeoutMs: 20,
    });
    await expect(Promise.race([
      teardown,
      new Promise((_, reject) => setTimeout(() => reject(new Error("outer timeout")), 250)),
    ])).rejects.toThrow(/taskkill.*timed out/iu);
    expect(killerWasStopped).toBe(true);
    expect(activeRecords.has(record)).toBe(true);
    expect(record.terminationPromise).toBeUndefined();
  });

  it("retries a failed owned teardown then remains idempotent after success", async () => {
    const record = { rootPid: 4242, terminating: false, terminationPromise: undefined };
    const activeRecords = new Set([record]);
    let attempts = 0;
    const spawnProcess = () => {
      attempts += 1;
      const killer = new EventEmitter();
      queueMicrotask(() => {
        if (attempts === 1) killer.emit("close", 1);
        else killer.emit("close", 0);
      });
      return killer;
    };
    await expect(smoke.terminateWindowsSupervisor(record, {
      activeRecords,
      spawnProcess,
      timeoutMs: 50,
    })).rejects.toThrow();
    await smoke.terminateWindowsSupervisor(record, { activeRecords, spawnProcess, timeoutMs: 50 });
    await smoke.terminateWindowsSupervisor(record, { activeRecords, spawnProcess, timeoutMs: 50 });
    expect(attempts).toBe(2);
    expect(activeRecords.has(record)).toBe(false);
  });

  it("retains ownership evidence without taskkill after the supervisor PID is lost", async () => {
    const record = {
      ownershipLost: true,
      rootPid: 4242,
      terminating: false,
      terminationPromise: undefined,
    };
    const activeRecords = new Set([record]);
    let spawnCalls = 0;
    await expect(smoke.terminateWindowsSupervisor(record, {
      activeRecords,
      spawnProcess: () => {
        spawnCalls += 1;
        const killer = new EventEmitter();
        queueMicrotask(() => killer.emit("close", 0));
        return killer;
      },
      timeoutMs: 50,
    })).rejects.toThrow(/ownership.*lost/iu);
    expect(spawnCalls).toBe(0);
    expect(activeRecords.has(record)).toBe(true);
  });

  it("settles the command promise when injected teardown fails", async () => {
    const commandPromise = smoke.runSmokeCommand(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      {
        platform: "linux",
        terminateRecords: async ([record]: Array<Record<string, any>>) => {
          record.child.kill("SIGKILL");
          throw new Error("injected teardown failure");
        },
        timeout: 20,
      },
    );
    await expect(Promise.race([
      commandPromise,
      new Promise((_, reject) => setTimeout(() => reject(new Error("outer timeout")), 500)),
    ])).rejects.toThrow("injected teardown failure");
  });

  it("keeps a persistent supervisor PID owned after its command leader exits", async () => {
    const actualSource = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
child.unref();
process.stdout.write(JSON.stringify({ grandchildPid: child.pid }) + "\\n");`;
    const plan = smoke.supervisedCommandPlan({
      args: ["-e", actualSource],
      executable: process.execPath,
      nodeExecutable: process.execPath,
      platform: "win32",
    });
    const supervisor = spawn(plan.executable, plan.args, {
      detached: process.platform !== "win32",
      env: smoke.sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    const resultMessage = new Promise<Record<string, unknown>>((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("message", (message) => resolve(message as Record<string, unknown>));
    });
    const supervisorExit = new Promise<void>((resolve) => {
      supervisor.once("exit", () => resolve());
    });
    let stdout = "";
    supervisor.stdout!.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    try {
      await expect(resultMessage).resolves.toEqual(expect.objectContaining({
        status: 0,
        type: "result",
      }));
      await waitUntil(() => stdout.endsWith("\n"));
      const { grandchildPid } = JSON.parse(stdout) as { grandchildPid: number };
      expect(processExists(supervisor.pid!)).toBe(true);
      expect(processExists(grandchildPid)).toBe(true);
      if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
          spawn("taskkill", ["/pid", String(supervisor.pid), "/t", "/f"], {
            stdio: "ignore",
          }).once("close", () => resolve());
        });
      } else {
        process.kill(-supervisor.pid!, "SIGKILL");
      }
      await supervisorExit;
      await waitUntil(() => !processExists(grandchildPid));
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        try {
          if (process.platform === "win32") supervisor.kill("SIGKILL");
          else process.kill(-supervisor.pid!, "SIGKILL");
        } catch {
          // The owned supervisor group has already exited.
        }
      }
    }
  }, 20_000);

  it("cleans its owned command tree when the parent IPC disconnects", async () => {
    const actualSource = `const { spawn } = require("node:child_process");
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
process.stdout.write(JSON.stringify({ childPid: process.pid, grandchildPid: child.pid }) + "\\n");
setInterval(() => {}, 1000);`;
    const plan = smoke.supervisedCommandPlan({
      args: ["-e", actualSource],
      executable: process.execPath,
      nodeExecutable: process.execPath,
      platform: "win32",
    });
    const supervisor = spawn(plan.executable, plan.args, {
      detached: process.platform !== "win32",
      env: smoke.sanitizedEnvironment(),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stdout = "";
    supervisor.stdout!.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    const supervisorExit = new Promise<void>((resolve, reject) => {
      supervisor.once("error", reject);
      supervisor.once("exit", () => resolve());
    });
    let owned: { childPid: number; grandchildPid: number } | undefined;
    try {
      await waitUntil(() => stdout.endsWith("\n"));
      owned = JSON.parse(stdout) as { childPid: number; grandchildPid: number };
      supervisor.disconnect();
      await Promise.race([
        supervisorExit,
        new Promise((_, reject) => setTimeout(() => reject(new Error("disconnect timeout")), 1500)),
      ]);
      await waitUntil(() => !processExists(owned!.childPid));
      await waitUntil(() => !processExists(owned!.grandchildPid));
    } finally {
      if (supervisor.exitCode === null && supervisor.signalCode === null) {
        try {
          if (process.platform === "win32") {
            spawn("taskkill", ["/pid", String(supervisor.pid), "/t", "/f"], {
              stdio: "ignore",
            });
          } else {
            process.kill(-supervisor.pid!, "SIGKILL");
          }
        } catch {
          // The exact owned supervisor group is already gone.
        }
      }
    }
  }, 20_000);

  it("compares all packed manifest publication fields to source", () => {
    const source = {
      name: "@402v/example",
      version: "0.1.0",
      type: "module",
      exports: { ".": "./src/index.mjs" },
      files: ["src"],
      license: "MIT",
      dependencies: { acorn: "^8.0.0" },
      engines: { node: ">=22" },
    };
    expect(() => smoke.assertPackedManifestMatches(source, structuredClone(source))).not.toThrow();
    expect(() => smoke.assertPackedManifestMatches(source, {
      ...structuredClone(source),
      dependencies: { acorn: "latest" },
    })).toThrow();
    expect(() => smoke.assertPackedManifestMatches(source, {
      ...structuredClone(source),
      private: true,
    })).toThrow();
  });

  it("cleans the exact temporary root and child after a global timeout", async () => {
    await cleanupProbe("timeout");
  }, 20_000);

  it("cleans the exact temporary root and child after SIGTERM", async () => {
    await cleanupProbe("signal", "SIGTERM");
  }, 20_000);

  it("cleans the exact temporary root and child after SIGINT", async () => {
    await cleanupProbe("signal", "SIGINT");
  }, 20_000);

  it("kills the original group after its leader exits and grandchild resists TERM", async () => {
    await cleanupProbe("leader-exit");
  }, 20_000);

  it("kills an output-limit process tree whose grandchild resists TERM", async () => {
    await cleanupProbe("output-limit");
  }, 20_000);
});
