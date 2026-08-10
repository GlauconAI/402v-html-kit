import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
  win32 as windowsPath,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import ts from "typescript";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const licenseDocumentPath = join(workspaceRoot, "docs", "dependency-licenses.md");
const packageDefinitions = Object.freeze([
  {
    name: "@402v/html-kit-cli",
    workspace: "packages/cli",
    files: [
      "package.json",
      "src/cli.mjs",
      "src/json-input.mjs",
      "src/theme-loader.mjs",
      "src/worker.mjs",
    ],
  },
  {
    name: "@402v/html-kit-core",
    workspace: "packages/core",
    files: [
      "package.json",
      "src/assets.d.mts",
      "src/assets.mjs",
      "src/atomic-install.d.mts",
      "src/atomic-install.mjs",
      "src/build-interactive.mjs",
      "src/build-note.mjs",
      "src/contracts.d.mts",
      "src/contracts.mjs",
      "src/data-accounting-v2.mjs",
      "src/data-blocks.d.mts",
      "src/data-blocks.mjs",
      "src/document-v2.mjs",
      "src/errors.d.mts",
      "src/errors.mjs",
      "src/flow.mjs",
      "src/frontmatter.mjs",
      "src/html-safety.mjs",
      "src/index.d.mts",
      "src/index.mjs",
      "src/interactive.mjs",
      "src/io.d.mts",
      "src/io.mjs",
      "src/manifest.mjs",
      "src/meta.mjs",
      "src/native-import.cjs",
      "src/render-markdown.mjs",
      "src/resource-limits.d.mts",
      "src/resource-limits.mjs",
      "src/runtime-v2.mjs",
      "src/theme-contract.d.mts",
      "src/theme-contract.mjs",
      "src/trusted-files.mjs",
      "src/update-data.mjs",
      "src/verify-common.mjs",
      "src/verify-v1.mjs",
      "src/verify-v2.mjs",
      "src/verify.mjs",
    ],
  },
  {
    name: "@402v/theme-402v",
    workspace: "packages/theme-402v",
    files: [
      "package.json",
      "src/index.d.mts",
      "src/index.mjs",
      "src/interactive-shell.mjs",
      "src/note-shell.mjs",
      "src/styles.mjs",
    ],
  },
]);
const packageNames = new Set(packageDefinitions.map(({ name }) => name));
const allowedLicenses = new Set([
  "Apache-2.0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "ISC",
  "MIT",
  "MIT-0",
]);
const forbiddenPayloadPatterns = Object.freeze([
  ["Supabase", /Supabase/giu],
  ["Vercel", /Vercel/giu],
  ["NEXT_PUBLIC_", /NEXT_PUBLIC_/giu],
  ["developer home path", /\/(?:Users|home)\/[^/\r\n]+(?:\/|$)/gu],
  ["Windows developer home path", /[A-Za-z]:\\Users\\[^\\\r\n]+(?:\\|$)/gu],
  ["local file URL", /file:\/\/\/(?:Users|home|private|tmp|var)\//gu],
  ["temporary host path", /\/(?:private\/)?tmp\/[^/\r\n]+/gu],
  ["macOS temporary host path", /\/var\/folders\/[A-Za-z0-9._/-]+/gu],
  ["private key", /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu],
  ["AWS access key", /AKIA[0-9A-Z]{16}/gu],
  ["GitHub token", /gh[opusr]_[A-Za-z0-9]{20,}/gu],
  ["Slack token", /xox[a-z]-[A-Za-z0-9-]{10,}/giu],
  [
    "literal credential",
    /(?:api[_-]?key|password|secret)\s*[:=]\s*["'](?!\$\{[A-Za-z_][A-Za-z0-9_]*\}["'])[^"'\n]{8,}["']/giu,
  ],
]);
const reviewedThemeBrandAnchor =
  '<a class="artifact-brand" href="https://402v.com">402v</a>';
const reviewedThemeBrandFiles = new Set([
  "src/interactive-shell.mjs",
  "src/note-shell.mjs",
]);

function fail(message) {
  throw new Error(message);
}

const inheritedEnvironmentNames = new Map([
  ["appdata", "APPDATA"],
  ["comspec", "ComSpec"],
  ["home", "HOME"],
  ["lang", "LANG"],
  ["lc_all", "LC_ALL"],
  ["localappdata", "LOCALAPPDATA"],
  ["path", "PATH"],
  ["pathext", "PATHEXT"],
  ["systemroot", "SystemRoot"],
  ["temp", "TEMP"],
  ["tmp", "TMP"],
  ["tmpdir", "TMPDIR"],
  ["userprofile", "USERPROFILE"],
  ["windir", "WINDIR"],
]);
const explicitEnvironmentAllowlist = new Set([
  "NO_COLOR",
  "npm_config_cache",
  "npm_config_globalconfig",
  "npm_config_ignore_scripts",
  "npm_config_loglevel",
  "npm_config_offline",
  "npm_config_prefix",
  "npm_config_userconfig",
]);

export function sanitizedEnvironment(inherited = process.env, overrides = {}) {
  const environment = {};
  for (const [key, value] of Object.entries(inherited)) {
    const canonical = inheritedEnvironmentNames.get(key.toLowerCase());
    if (value !== undefined && canonical !== undefined) {
      environment[canonical] = value;
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (
      value !== undefined &&
      (inheritedEnvironmentNames.has(key.toLowerCase()) || explicitEnvironmentAllowlist.has(key))
    ) {
      environment[inheritedEnvironmentNames.get(key.toLowerCase()) ?? key] = String(value);
    }
  }
  return environment;
}

function sensitiveCredentialName(name) {
  return typeof name === "string" && /^(?:api[_-]?key|password|secret)$/iu.test(name);
}

function safeInterpolation(value) {
  return /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/u.test(value);
}

const unknownStaticValue = Symbol("unknown-static-value");

function staticValue(node, scope) {
  if (node === undefined) return undefined;
  while (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isTypeAssertionExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node)
  ) {
    node = node.expression;
  }
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isIdentifier(node)) {
    const value = scope.get(node.text);
    return value === unknownStaticValue ? undefined : value;
  }
  if (ts.isTemplateExpression(node)) {
    let value = node.head.text;
    for (const span of node.templateSpans) {
      const expression = staticValue(span.expression, scope);
      if (typeof expression !== "string") return undefined;
      value += expression + span.literal.text;
    }
    return value;
  }
  if (
    ts.isBinaryExpression(node) &&
    node.operatorToken.kind === ts.SyntaxKind.PlusToken
  ) {
    const left = staticValue(node.left, scope);
    const right = staticValue(node.right, scope);
    return typeof left === "string" && typeof right === "string"
      ? left + right
      : undefined;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const values = node.elements.map((element) => staticValue(element, scope));
    return values.every((value) => typeof value === "string") ? values : undefined;
  }
  if (
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression) &&
    node.expression.name.text === "join" &&
    node.arguments.length === 1 &&
    staticValue(node.arguments[0], scope) === ""
  ) {
    const values = staticValue(node.expression.expression, scope);
    return Array.isArray(values) ? values.join("") : undefined;
  }
  return undefined;
}

function typescriptPropertyName(node) {
  if (node !== undefined && ts.isIdentifier(node)) return node.text;
  if (node !== undefined && ts.isStringLiteralLike(node)) return node.text;
  return undefined;
}

function collectStaticValue(value, values) {
  if (typeof value === "string") values.push(value);
  else if (Array.isArray(value)) values.push(...value);
}

function decodedTypeScriptValues(source, path) {
  const values = [];
  const credentials = [];
  const scriptKind = path.endsWith(".tsx")
    ? ts.ScriptKind.TSX
    : path.endsWith(".jsx")
      ? ts.ScriptKind.JSX
      : /\.(?:cjs|js|mjs)$/iu.test(path)
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  if (sourceFile.parseDiagnostics?.length > 0) {
    fail(`Published source cannot be parsed statically: ${path}`);
  }

  const inspectCredential = (name, value) => {
    if (sensitiveCredentialName(name) && typeof value === "string") {
      credentials.push(value);
    }
  };
  const populateLexicalBindings = (statements, scope) => {
    const immutableBindings = [];
    for (const statement of statements) {
      if (!ts.isVariableStatement(statement)) continue;
      const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue;
        scope.set(declaration.name.text, unknownStaticValue);
        if (isConst) immutableBindings.push(declaration);
      }
    }
    let changed = true;
    while (changed) {
      changed = false;
      for (const declaration of immutableBindings) {
        if (scope.get(declaration.name.text) !== unknownStaticValue) continue;
        const value = staticValue(declaration.initializer, scope);
        if (value !== undefined) {
          scope.set(declaration.name.text, value);
          changed = true;
        }
      }
    }
  };
  const visit = (node, scope) => {
    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      const childScope = new Map(scope);
      populateLexicalBindings(node.statements, childScope);
      for (const statement of node.statements) {
        if (ts.isVariableStatement(statement)) {
          for (const declaration of statement.declarationList.declarations) {
            const value = staticValue(declaration.initializer, childScope);
            collectStaticValue(value, values);
            if (ts.isIdentifier(declaration.name)) {
              inspectCredential(declaration.name.text, value);
            }
            if (declaration.initializer !== undefined) {
              ts.forEachChild(declaration.initializer, (child) => visit(child, childScope));
            }
            if (declaration.type !== undefined) visit(declaration.type, childScope);
          }
        } else {
          visit(statement, childScope);
        }
      }
      return;
    }
    if (ts.isFunctionLike(node) && node.body !== undefined) {
      const functionScope = new Map(scope);
      for (const parameter of node.parameters) {
        if (ts.isIdentifier(parameter.name)) {
          functionScope.set(parameter.name.text, unknownStaticValue);
        }
      }
      visit(node.body, functionScope);
      return;
    }
    const value = staticValue(node, scope);
    collectStaticValue(value, values);
    if (ts.isPropertyAssignment(node)) {
      inspectCredential(typescriptPropertyName(node.name), staticValue(node.initializer, scope));
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken
    ) {
      const name = ts.isPropertyAccessExpression(node.left)
        ? node.left.name.text
        : typescriptPropertyName(node.left);
      inspectCredential(name, staticValue(node.right, scope));
    }
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(sourceFile, new Map());
  return { credentials, values };
}

function decodedDocumentValues(source, path) {
  const values = [];
  const credentials = [];
  if (path.endsWith(".json") || path === "package.json") {
    const document = JSON.parse(source);
    const visit = (value, key) => {
      if (typeof value === "string") {
        values.push(value);
        if (sensitiveCredentialName(key)) credentials.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) visit(item, undefined);
      } else if (value !== null && typeof value === "object") {
        for (const [childKey, child] of Object.entries(value)) visit(child, childKey);
      }
    };
    visit(document, undefined);
    return { credentials, values };
  }
  if (!/\.(?:cjs|d\.mts|js|jsx|mjs|mts|ts|tsx)$/iu.test(path)) {
    return { credentials, values };
  }
  return decodedTypeScriptValues(source, path);
}

function scanForbiddenValue(packageName, path, value, decoded = false) {
  if (
    decoded &&
    (/^\/(?!\/)(?:[^/\0\r\n]+\/)+[^/\0\r\n]*$/u.test(value) ||
      /^[A-Za-z]:\\(?:[^\\\0\r\n]+\\)+[^\\\0\r\n]*$/u.test(value))
  ) {
    fail(`absolute host path found in ${packageName}/${path}`);
  }
  if (/402v\.com/iu.test(value)) {
    fail(`Unreviewed 402v.com occurrence in ${packageName}/${path}`);
  }
  for (const [label, pattern] of forbiddenPayloadPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(value)) fail(`${label} found in ${packageName}/${path}`);
  }
}

export function inspectPublishedText({
  packageName,
  path,
  content,
  reviewedBrandFiles,
}) {
  let source;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    fail(`Invalid UTF-8 in ${packageName}/${path}`);
  }
  const reviewedPath =
    packageName === "@402v/theme-402v" && reviewedThemeBrandFiles.has(path);
  if (reviewedPath) {
    if (source.split(reviewedThemeBrandAnchor).length !== 2) {
      fail(`Reviewed theme brand href changed in ${path}`);
    }
    reviewedBrandFiles?.add(path);
    source = source.replace(reviewedThemeBrandAnchor, "");
  }
  const decoded = decodedDocumentValues(source, path);
  scanForbiddenValue(packageName, path, source);
  for (const value of decoded.values) scanForbiddenValue(packageName, path, value, true);
  for (const credential of decoded.credentials) {
    if (credential.length >= 8 && !safeInterpolation(credential)) {
      fail(`literal credential found in ${packageName}/${path}`);
    }
  }
  return { reviewedBrandAnchor: reviewedPath };
}

export function installedBinaryPlan({
  binaryBase,
  packageEntry,
  platform = process.platform,
  nodeExecutable = process.execPath,
}) {
  if (platform === "win32") {
    return {
      executable: nodeExecutable,
      packageEntry,
      platform,
      prefixArgs: [packageEntry],
      shimPath: `${binaryBase}.cmd`,
      verifiesCmdShim: true,
    };
  }
  return {
    executable: binaryBase,
    packageEntry,
    platform,
    prefixArgs: [],
    shimPath: binaryBase,
    nodeExecutable,
  };
}

export function npmExecutionPlan({
  comSpec,
  nodeExecutable = process.execPath,
  npmExecPath,
  platform = process.platform,
}) {
  if (platform !== "win32") {
    return { executable: "npm", platform, prefixArgs: [], strategy: "direct" };
  }
  if (npmExecPath !== undefined) {
    if (
      typeof npmExecPath !== "string" ||
      !windowsPath.isAbsolute(npmExecPath) ||
      !/^npm-cli\.(?:js|mjs)$/iu.test(windowsPath.basename(npmExecPath))
    ) {
      fail(`Invalid Windows npm CLI entry: ${String(npmExecPath)}`);
    }
    return {
      executable: nodeExecutable,
      platform,
      prefixArgs: [npmExecPath],
      strategy: "cli-entry",
    };
  }
  if (typeof comSpec !== "string" || !windowsPath.isAbsolute(comSpec)) {
    fail("Windows npm execution requires a validated npm CLI entry or ComSpec");
  }
  return {
    executable: comSpec,
    platform,
    prefixArgs: ["/d", "/s", "/c"],
    strategy: "comspec",
  };
}

function windowsCommandQuote(value) {
  if (/[\0\r\n]/u.test(value)) fail("Unsafe Windows command argument");
  return `"${value.replaceAll('"', '""').replaceAll("%", "%%")}"`;
}

function npmCommandArguments(plan, args) {
  if (plan.strategy !== "comspec") return [...plan.prefixArgs, ...args];
  return [
    ...plan.prefixArgs,
    ["npm.cmd", ...args.map(windowsCommandQuote)].join(" "),
  ];
}

export function binaryCommandArguments(plan, args) {
  return [...plan.prefixArgs, ...args];
}

function activeWindowsCmdShimSource(content) {
  let shim;
  try {
    shim = new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    fail("Installed Windows cmd shim is not valid UTF-8");
  }
  return shim.split(/\r?\n/u).filter((line) => {
    const normalized = line.trim().replace(/^@/u, "");
    return normalized !== "" && !/^(?:rem(?:\s|$)|::)/iu.test(normalized);
  }).join("\n");
}

export function verifyWindowsCmdShim(content) {
  const activeSource = activeWindowsCmdShimSource(content);
  if (!/%(?:~?dp0)%[\\/]\.\.[\\/]@402v[\\/]html-kit-cli[\\/]src[\\/]cli\.mjs/iu.test(activeSource)) {
    fail("Installed Windows cmd shim does not target the packed CLI entry");
  }
}

export async function probeWindowsInstalledShim({
  args = ["--help"],
  comSpec,
  run,
  shimContent,
  shimPath,
}) {
  verifyWindowsCmdShim(shimContent);
  const result = await run({
    args: [
      "/d",
      "/s",
      "/c",
      [windowsCommandQuote(shimPath), ...args.map(windowsCommandQuote)].join(" "),
    ],
    executable: comSpec,
    shimPath,
  });
  if (result.status !== 0 || result.stderr !== "") {
    fail(`Windows cmd shim probe failed: ${result.stderr}`);
  }
  const lines = result.stdout.trimEnd().split("\n");
  if (!result.stdout.endsWith("\n") || lines.length !== 1) {
    fail("Windows cmd shim probe did not emit exactly one JSON line");
  }
  const parsed = JSON.parse(lines[0]);
  if (parsed?.ok !== true) fail("Windows cmd shim probe returned a failed result");
  return parsed;
}

export function hashArchive(archive, algorithm) {
  return createHash(algorithm).update(archive).digest();
}

export function verifyArchiveIntegrity(archive, integrity) {
  const match = integrity?.match(/^([a-z0-9]+)-(.+)$/iu);
  if (match === null || match === undefined) fail("Invalid archive integrity");
  if (match[1] !== "sha512") fail("Archive integrity algorithm must be sha512");
  const expected = Buffer.from(match[2], "base64");
  const actual = hashArchive(archive, match[1]);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    fail("Archive integrity does not match packed bytes");
  }
}

export function assertPackedManifestMatches(sourceManifest, packedManifest) {
  if (!isDeepStrictEqual(sourceManifest, packedManifest)) {
    fail("Packed manifest differs from the source package.json");
  }
}

export function validatePackFilename({ filename, name, tarballRoot, version }) {
  const expected = `${name.replace(/^@/u, "").replace("/", "-")}-${version}.tgz`;
  const candidate = resolve(tarballRoot, filename);
  if (
    filename !== expected ||
    basename(filename) !== filename ||
    !contained(tarballRoot, candidate)
  ) {
    fail(`Unexpected npm pack filename for ${name}: ${filename}`);
  }
  return candidate;
}

function normalizedRelative(from, to) {
  return relative(from, to).split(sep).join("/");
}

function contained(root, candidate) {
  const difference = relative(root, candidate);
  return difference === "" || (
    !isAbsolute(difference) &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`)
  );
}

const activeProcessTrees = new Set();
let runDeadline = Number.POSITIVE_INFINITY;
let shutdownError;

class SmokeExitError extends Error {
  constructor(message, exitCode) {
    super(message);
    this.exitCode = exitCode;
  }
}

function assertRunActive() {
  if (shutdownError !== undefined) throw shutdownError;
  if (Date.now() >= runDeadline) {
    throw new SmokeExitError("Package smoke global deadline exceeded", 124);
  }
}

async function signalProcessTree(snapshot, signal) {
  if (process.platform === "win32") {
    await new Promise((resolvePromise) => {
      const killer = spawn("taskkill", ["/pid", String(snapshot.rootPid), "/t", "/f"], {
        env: sanitizedEnvironment(),
        stdio: "ignore",
      });
      killer.once("error", resolvePromise);
      killer.once("close", resolvePromise);
    });
    return;
  }
  try {
    process.kill(-snapshot.groupId, signal);
  } catch {
    // ESRCH means this exact process group is already gone.
  }
}

async function terminateProcessTrees(records) {
  const uniqueRecords = [...new Set(records)];
  if (uniqueRecords.length === 0) return;
  const snapshots = uniqueRecords.map((record) => ({
    groupId: record.groupId,
    rootPid: record.rootPid,
  }));
  for (const record of uniqueRecords) record.terminating = true;
  await Promise.all(snapshots.map((snapshot) => signalProcessTree(snapshot, "SIGTERM")));
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
  await Promise.all(snapshots.map((snapshot) => signalProcessTree(snapshot, "SIGKILL")));
  for (const record of uniqueRecords) activeProcessTrees.delete(record);
}

async function terminateActiveChildren() {
  const records = [...activeProcessTrees];
  await terminateProcessTrees(records);
}

async function command(executable, args, options = {}) {
  if (shutdownError !== undefined) throw shutdownError;
  const remaining = runDeadline - Date.now();
  if (remaining <= 0) throw new SmokeExitError("Package smoke global deadline exceeded", 124);
  const timeout = Math.max(1, Math.min(options.timeout ?? 120_000, remaining));
  return await new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? workspaceRoot,
      detached: process.platform !== "win32",
      env: sanitizedEnvironment(process.env, {
        NO_COLOR: "1",
        ...options.env,
      }),
      stdio: ["ignore", "pipe", "pipe"],
    });
    const record = {
      child,
      groupId: child.pid,
      rootPid: child.pid,
      terminating: false,
      terminationPromise: undefined,
    };
    activeProcessTrees.add(record);
    options.onSpawn?.(child);
    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputLimited = false;
    const terminateRecord = () => {
      record.terminationPromise ??= terminateProcessTrees([record]);
      return record.terminationPromise;
    };
    const capture = (chunks) => (chunk) => {
      if (outputLimited) return;
      outputBytes += chunk.length;
      if (outputBytes > 4 * 1024 * 1024) {
        outputLimited = true;
        void terminateRecord();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on("data", capture(stdout));
    child.stderr.on("data", capture(stderr));
    const timer = setTimeout(() => {
      timedOut = true;
      void terminateRecord();
    }, timeout);
    timer.unref();
    child.once("error", (error) => {
      clearTimeout(timer);
      activeProcessTrees.delete(record);
      rejectPromise(new Error(`${executable} could not run: ${error.message}`));
    });
    child.once("close", async (status, signal) => {
      clearTimeout(timer);
      if (!record.terminating) {
        let processTreeSurvives = false;
        if (process.platform !== "win32") {
          try {
            process.kill(-record.groupId, 0);
            processTreeSurvives = true;
          } catch {
            // This exact process group has exited completely.
          }
        }
        if (!processTreeSurvives) activeProcessTrees.delete(record);
      }
      if (record.terminationPromise !== undefined) await record.terminationPromise;
      const result = {
        status,
        signal,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      };
      if (shutdownError !== undefined) {
        rejectPromise(shutdownError);
      } else if (timedOut || outputLimited) {
        rejectPromise(new SmokeExitError(
          `${executable} exceeded its ${outputLimited ? "output limit" : "timeout"}`,
          124,
        ));
      } else if (status !== 0) {
        rejectPromise(new Error(
          `${executable} ${args.join(" ")} exited ${status ?? signal}\n` +
          `${result.stdout}${result.stderr}`,
        ));
      } else {
        resolvePromise(result);
      }
    });
  });
}

async function jsonCommand(executable, args, cwd, plan) {
  const commandArgs = plan === undefined ? args : binaryCommandArguments(plan, args);
  const result = await command(executable, commandArgs, { cwd });
  if (result.stderr !== "") {
    fail(`${executable} wrote to stderr: ${result.stderr}`);
  }
  const lines = result.stdout.trimEnd().split("\n");
  if (!result.stdout.endsWith("\n") || lines.length !== 1) {
    fail(`${executable} did not emit exactly one JSON line: ${result.stdout}`);
  }
  const parsed = JSON.parse(lines[0]);
  if (parsed?.ok !== true) fail(`${executable} returned a failed result`);
  return parsed;
}

async function runNpm(plan, args, options = {}) {
  return await command(plan.executable, npmCommandArguments(plan, args), options);
}

function readTarEntries(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  const entries = [];
  const directories = [];
  let offset = 0;
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const readString = (start, length) =>
      header.subarray(start, start + length).toString("utf8").replace(/\0.*$/su, "");
    const name = readString(0, 100);
    const prefix = readString(345, 155);
    const path = prefix === "" ? name : `${prefix}/${name}`;
    const sizeText = readString(124, 12).trim();
    const modeText = readString(100, 8).trim();
    const checksumText = readString(148, 8).trim();
    const size = sizeText === "" ? 0 : Number.parseInt(sizeText, 8);
    const mode = modeText === "" ? 0 : Number.parseInt(modeText, 8);
    const recordedChecksum = Number.parseInt(checksumText, 8);
    if (![size, mode, recordedChecksum].every(Number.isFinite)) {
      fail(`Invalid tar header for ${path}`);
    }
    let checksum = 0;
    for (let index = 0; index < header.length; index += 1) {
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    }
    if (checksum !== recordedChecksum) fail(`Invalid tar checksum for ${path}`);
    const bodyStart = offset + 512;
    const bodyEnd = bodyStart + size;
    if (bodyEnd > archive.length) fail(`Truncated tar entry for ${path}`);
    const type = String.fromCharCode(header[156] || 48);
    if (type === "0") {
      entries.push({ path, mode, content: archive.subarray(bodyStart, bodyEnd) });
    } else if (type === "5") {
      directories.push({ path, mode });
    } else {
      fail(`Unsupported tar entry type ${type} for ${path}`);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  if (archive.subarray(offset).some((byte) => byte !== 0)) {
    fail("Tarball contains non-zero trailing bytes");
  }
  return { directories, entries };
}

function assertSafeArchivePath(path) {
  if (
    isAbsolute(path) ||
    /^[A-Za-z]:[\\/]/u.test(path) ||
    path.split("/").includes("..") ||
    path.includes("\\")
  ) {
    fail(`Unsafe archive path: ${path}`);
  }
  if (/(?:^|\/)\.env(?:\.|$)/iu.test(path)) fail(`Environment file packed: ${path}`);
  if (/(?:^|\/)(?:tests?|__tests__)(?:\/|$)|\.test\.[^/]+$/iu.test(path)) {
    fail(`Test file packed: ${path}`);
  }
  if (
    /(?:^|\/)(?:app|site|server|supabase|vercel|publisher|publishing|remote)(?:[./-]|\/|$)/iu.test(path)
  ) {
    fail(`Site-only module packed: ${path}`);
  }
}

function scanPackedText(packageName, path, content, reviewedBrandFiles) {
  inspectPublishedText({ packageName, path, content, reviewedBrandFiles });
}

function inspectTarball(definition, details, tarballRoot) {
  if (details.name !== definition.name) {
    fail(`npm pack returned ${details.name} for ${definition.name}`);
  }
  const manifest = JSON.parse(
    readFileSync(join(workspaceRoot, definition.workspace, "package.json"), "utf8"),
  );
  if (details.version !== manifest.version) {
    fail(`npm pack returned version ${details.version} for ${definition.name}`);
  }
  const tarballPath = validatePackFilename({
    filename: details.filename,
    name: definition.name,
    tarballRoot,
    version: manifest.version,
  });
  const archive = readFileSync(tarballPath);
  if (archive.length !== details.size) fail(`Compressed size mismatch for ${definition.name}`);
  verifyArchiveIntegrity(archive, details.integrity);
  const expected = [...definition.files].sort();
  const reported = details.files.map(({ path }) => path).sort();
  if (JSON.stringify(reported) !== JSON.stringify(expected)) {
    fail(
      `${definition.name} tarball allowlist mismatch\n` +
      `expected: ${expected.join(", ")}\nactual: ${reported.join(", ")}`,
    );
  }
  for (const path of reported) assertSafeArchivePath(path);

  if (details.entryCount !== expected.length || details.files.length !== expected.length) {
    fail(`npm pack entry count mismatch for ${definition.name}`);
  }
  const { directories, entries } = readTarEntries(tarballPath);
  const allowedDirectories = new Set(["package", "package/src"]);
  const seenDirectories = new Set();
  for (const directory of directories) {
    const normalized = directory.path.replace(/\/$/u, "");
    assertSafeArchivePath(normalized);
    if (
      seenDirectories.has(normalized) ||
      !allowedDirectories.has(normalized) ||
      (directory.mode & 0o022) !== 0
    ) {
      fail(`Unexpected or writable tar directory: ${directory.path}`);
    }
    seenDirectories.add(normalized);
  }
  const reviewedBrandFiles = new Set();
  const payloadPaths = [];
  const seenPaths = new Set();
  let unpackedSize = 0;
  for (const entry of entries) {
    if (!entry.path.startsWith("package/")) {
      fail(`Tarball entry lacks package/ prefix: ${entry.path}`);
    }
    const path = entry.path.slice("package/".length);
    assertSafeArchivePath(path);
    if (seenPaths.has(path)) fail(`Duplicate tar entry: ${path}`);
    seenPaths.add(path);
    payloadPaths.push(path);
    unpackedSize += entry.content.length;
    const reportedEntry = details.files.find((file) => file.path === path);
    if (
      reportedEntry === undefined ||
      reportedEntry.size !== entry.content.length ||
      (reportedEntry.mode & 0o777) !== (entry.mode & 0o777)
    ) {
      fail(`Tar metadata differs from npm pack report for ${definition.name}/${path}`);
    }
    scanPackedText(definition.name, path, entry.content, reviewedBrandFiles);
    if (
      definition.name === "@402v/html-kit-cli" &&
      path === "src/cli.mjs" &&
      (entry.mode & 0o111) === 0
    ) {
      fail("Packed CLI entry is not executable");
    }
  }
  payloadPaths.sort();
  if (JSON.stringify(payloadPaths) !== JSON.stringify(expected)) {
    fail(`${definition.name} tar payload differs from npm pack file report`);
  }
  if (unpackedSize !== details.unpackedSize) {
    fail(`Unpacked size mismatch for ${definition.name}`);
  }
  const packedManifestEntry = entries.find(({ path }) => path === "package/package.json");
  if (packedManifestEntry === undefined) fail(`Packed manifest missing for ${definition.name}`);
  const packedManifest = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(packedManifestEntry.content),
  );
  assertPackedManifestMatches(manifest, packedManifest);
  if (
    definition.name === "@402v/theme-402v" &&
    (reviewedBrandFiles.size !== reviewedThemeBrandFiles.size ||
      [...reviewedThemeBrandFiles].some((path) => !reviewedBrandFiles.has(path)))
  ) {
    fail("The exact reviewed theme brand hrefs were not both present");
  }
  return {
    name: definition.name,
    filename: details.filename,
    integrity: details.integrity,
    fileCount: expected.length,
    unpackedSize: details.unpackedSize,
  };
}

function cacheContentPath(cacheRoot, integrity) {
  const match = integrity?.match(/^([a-z0-9]+)-(.+)$/iu);
  if (match === null || match === undefined) {
    fail(`Unsupported or missing lock integrity: ${String(integrity)}`);
  }
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

async function seedPrivateCache(sourceLock, privateCache, npmHostEnvironment, npmPlan) {
  const hostCache = (
    await runNpm(npmPlan, ["config", "get", "cache"], { env: npmHostEnvironment })
  ).stdout.trim();
  const productionEntries = {};
  for (const [path, entry] of Object.entries(sourceLock.packages)) {
    if (
      !path.startsWith("node_modules/") ||
      /(?:^|\/)node_modules\/@402v\//u.test(path) ||
      entry.dev === true
    ) {
      continue;
    }
    const source = cacheContentPath(hostCache, entry.integrity);
    if (!existsSync(source)) {
      if (entry.optional === true) continue;
      fail(`Required production tarball is absent from the npm cache: ${path}`);
    }
    const destination = cacheContentPath(privateCache, entry.integrity);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    productionEntries[path] = entry;
  }
  return productionEntries;
}

function writeConsumerLock(consumerRoot, tarballRoot, packed, productionEntries) {
  const dependencies = {};
  const packages = { ...productionEntries };
  for (const definition of packageDefinitions) {
    const details = packed.get(definition.name);
    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, definition.workspace, "package.json"), "utf8"),
    );
    const specifier = `file:${normalizedRelative(
      consumerRoot,
      join(tarballRoot, details.filename),
    )}`;
    dependencies[definition.name] = specifier;
    packages[`node_modules/${definition.name}`] = {
      version: manifest.version,
      resolved: specifier,
      integrity: details.integrity,
      license: manifest.license,
      ...(manifest.bin === undefined ? {} : { bin: manifest.bin }),
      ...(manifest.dependencies === undefined
        ? {}
        : { dependencies: manifest.dependencies }),
      ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
    };
  }
  packages[""] = {
    name: "html-kit-packed-smoke-consumer",
    dependencies,
  };
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({
      name: "html-kit-packed-smoke-consumer",
      private: true,
      type: "module",
      dependencies,
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumerRoot, "package-lock.json"),
    `${JSON.stringify({
      name: "html-kit-packed-smoke-consumer",
      lockfileVersion: 3,
      requires: true,
      packages,
    }, null, 2)}\n`,
  );
}

function writeConsumerFixtures(consumerRoot) {
  const fixtureRoot = join(consumerRoot, "fixtures");
  mkdirSync(fixtureRoot);
  writeFileSync(
    join(fixtureRoot, "note.md"),
    "---\ntitle: Packed Note\ndescription: Offline package smoke.\n---\n\n# Packed Note\n\nTarballs only.\n",
  );
  writeFileSync(join(fixtureRoot, "data.json"), '{"ready":true,"count":1}\n');
  writeFileSync(join(fixtureRoot, "updated.json"), '{"ready":false,"count":2}\n');
  writeFileSync(
    join(fixtureRoot, "renderer.mjs"),
    "export function renderArtifact({ data }) { return { mainSections: `<main>${data.registry.count}</main>` }; }\n",
  );
  writeFileSync(
    join(fixtureRoot, "artifact.mjs"),
    `export default {
  contractVersion: 2,
  mode: "interactive",
  metadata: { title: "Packed Interactive", description: "Offline package smoke.", eyebrow: "Smoke", lang: "en" },
  dataBlocks: [{ id: "registry", source: "./data.json" }],
  renderer: "./renderer.mjs",
  styles: [], scripts: [], svgAssets: [], requiredDataBlocks: ["registry"],
  theme: "@402v/theme-402v"
};
`,
  );
  writeFileSync(
    join(consumerRoot, "imports.mjs"),
    `import * as core from "@402v/html-kit-core";
import theme from "@402v/theme-402v";
if (typeof core.verifyArtifact !== "function" || theme.id !== "402v") process.exit(10);
const originalArgv = process.argv;
const originalWrite = process.stdout.write.bind(process.stdout);
let output = "";
process.argv = [process.execPath, "402v-html-kit", "--help"];
process.stdout.write = (chunk) => { output += String(chunk); return true; };
await import("@402v/html-kit-cli");
process.argv = originalArgv;
process.stdout.write = originalWrite;
if (!output.startsWith("402v HTML Kit")) process.exit(11);
originalWrite(JSON.stringify({
  environment: Object.fromEntries([
    "INIT_CWD",
    "NODE_OPTIONS",
    "NODE_PATH",
    "NPM_CONFIG_CACHE",
    "YARN_GLOBAL_FOLDER",
    "npm_config_registry",
  ].map((name) => [name, process.env[name] ?? null])),
  resolutions: Object.fromEntries([
    "@402v/html-kit-core",
    "@402v/html-kit-cli",
    "@402v/theme-402v",
  ].map((name) => [name, import.meta.resolve(name)])),
}));
`,
  );
  return fixtureRoot;
}

async function exerciseConsumer(consumerRoot) {
  for (const name of packageNames) {
    const packageRoot = realpathSync(join(consumerRoot, "node_modules", ...name.split("/")));
    if (!contained(consumerRoot, packageRoot)) {
      fail(`Installed package resolves outside the clean consumer: ${name}`);
    }
  }
  const binaryBase = join(
    consumerRoot,
    "node_modules",
    ".bin",
    "402v-html-kit",
  );
  const packageEntry = realpathSync(join(
    consumerRoot,
    "node_modules",
    "@402v",
    "html-kit-cli",
    "src",
    "cli.mjs",
  ));
  const plan = installedBinaryPlan({
    binaryBase,
    packageEntry,
  });
  const resolvedShim = realpathSync(plan.shimPath);
  if (!contained(consumerRoot, resolvedShim)) fail("CLI binary resolves outside consumer");
  if (!contained(consumerRoot, packageEntry)) fail("CLI package entry resolves outside consumer");
  if (process.platform !== "win32" && (statSync(resolvedShim).mode & 0o111) === 0) {
    fail("Installed CLI is not executable");
  }
  if (process.platform === "win32") {
    verifyWindowsCmdShim(readFileSync(plan.shimPath));
  }

  const fixtureRoot = writeConsumerFixtures(consumerRoot);
  await jsonCommand(plan.executable, ["build", "note.md", "--output", "note.html"], fixtureRoot, plan);
  await jsonCommand(plan.executable, ["verify", "note.html"], fixtureRoot, plan);
  await jsonCommand(
    plan.executable,
    ["build-artifact", "artifact.mjs", "--output", "artifact.html"],
    fixtureRoot,
    plan,
  );
  await jsonCommand(plan.executable, ["verify", "artifact.html", "--required-block", "registry"], fixtureRoot, plan);
  if (process.platform === "win32") {
    const comSpec = sanitizedEnvironment().ComSpec;
    if (typeof comSpec !== "string" || !windowsPath.isAbsolute(comSpec)) {
      fail("Windows cmd shim probe requires an absolute ComSpec");
    }
    await probeWindowsInstalledShim({
      args: ["verify", "artifact.html", "--required-block", "registry"],
      comSpec,
      run: async ({ args, executable }) => await command(executable, args, { cwd: fixtureRoot }),
      shimContent: readFileSync(plan.shimPath),
      shimPath: plan.shimPath,
    });
  }
  await jsonCommand(
    plan.executable,
    [
      "update-data",
      "artifact.html",
      "--manifest",
      "artifact.mjs",
      "--id",
      "registry",
      "--input",
      "updated.json",
    ],
    fixtureRoot,
    plan,
  );
  await jsonCommand(plan.executable, ["verify", "artifact.html", "--required-block", "registry"], fixtureRoot, plan);
  const imports = await command(process.execPath, [join(consumerRoot, "imports.mjs")], {
    cwd: consumerRoot,
  });
  const importProbe = JSON.parse(imports.stdout);
  for (const name of packageNames) {
    const resolved = fileURLToPath(importProbe.resolutions[name]);
    if (!contained(consumerRoot, resolved)) {
      fail(`Programmatic import resolves outside the clean consumer: ${name}`);
    }
  }
  if (Object.values(importProbe.environment).some((value) => value !== null)) {
    fail("Resolution-affecting environment leaked into the consumer import probe");
  }
  return true;
}

function installedProductionLicenses(consumerRoot, consumerLock) {
  const licenses = [];
  for (const [path, lockEntry] of Object.entries(consumerLock.packages)) {
    if (!path.startsWith("node_modules/") || lockEntry.dev === true) continue;
    const manifestPath = join(consumerRoot, path, "package.json");
    if (!existsSync(manifestPath)) {
      if (lockEntry.optional === true) continue;
      fail(`Installed production package metadata missing: ${path}`);
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const license = typeof manifest.license === "string"
      ? manifest.license
      : typeof manifest.license?.type === "string"
        ? manifest.license.type
        : undefined;
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      fail(`Invalid installed package metadata: ${path}`);
    }
    if (license === undefined || !allowedLicenses.has(license)) {
      fail(
        `Unknown or non-allowlisted production license for ` +
        `${manifest.name}@${manifest.version}: ${String(license)}`,
      );
    }
    licenses.push({ name: manifest.name, version: manifest.version, license });
  }
  const unique = new Map();
  for (const entry of licenses) unique.set(`${entry.name}\0${entry.version}`, entry);
  return [...unique.values()].sort((left, right) =>
    left.name.localeCompare(right.name) || left.version.localeCompare(right.version),
  );
}

function renderLicenseDocument(licenses) {
  const rows = licenses.map(({ name, version, license }) =>
    `| ${name.replaceAll("|", "\\|")} | ${version} | ${license} |`,
  );
  return `# Production dependency licenses

This file is generated deterministically by \`npm run pack:check\` from the
installed production package metadata in a clean, tarball-only consumer.
Unknown licenses and licenses outside the reviewed allowlist fail the gate.
Reviewed licenses: Apache-2.0, BSD-2-Clause, BSD-3-Clause, BlueOak-1.0.0,
CC0-1.0, ISC, MIT, and MIT-0.

The official \`@402v/theme-402v\` tarball intentionally contains exactly two
reviewed \`https://402v.com\` brand links (one note shell and one interactive
shell). All other private-infrastructure identifiers remain forbidden.

| Package | Version | License |
| --- | --- | --- |
${rows.join("\n")}
`;
}

async function runPackSmoke() {
  const configuredTimeout = Number.parseInt(
    process.env.PACK_SMOKE_GLOBAL_TIMEOUT_MS ?? "150000",
    10,
  );
  if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout < 100) {
    fail("PACK_SMOKE_GLOBAL_TIMEOUT_MS must be an integer of at least 100");
  }
  runDeadline = Date.now() + configuredTimeout;
  shutdownError = undefined;
  let temporaryRoot;
  let cleaned = false;
  const cleanupExactRoot = async () => {
    if (cleaned) return;
    cleaned = true;
    await terminateActiveChildren();
    if (temporaryRoot !== undefined) {
      try {
        chmodSync(temporaryRoot, 0o700);
      } catch {
        // Recursive removal below reports any remaining cleanup failure.
      }
      rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
      if (existsSync(temporaryRoot)) fail(`Temporary root cleanup failed: ${temporaryRoot}`);
    }
  };
  const requestShutdown = (message, exitCode) => {
    if (shutdownError === undefined) shutdownError = new SmokeExitError(message, exitCode);
    void terminateActiveChildren();
  };
  const onSigint = () => requestShutdown("Package smoke interrupted by SIGINT", 130);
  const onSigterm = () => requestShutdown("Package smoke interrupted by SIGTERM", 143);
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);
  const deadlineTimer = setTimeout(
    () => requestShutdown("Package smoke global deadline exceeded", 124),
    configuredTimeout,
  );
  deadlineTimer.unref();

  try {
    const temporaryParent = process.argv.includes("--cleanup-probe")
      ? process.env.PACK_SMOKE_PROBE_PARENT
      : tmpdir();
    if (typeof temporaryParent !== "string" || !isAbsolute(temporaryParent)) {
      fail("Cleanup probe requires an absolute PACK_SMOKE_PROBE_PARENT");
    }
    temporaryRoot = mkdtempSync(join(temporaryParent, "402v-pack-smoke-"));

    if (process.argv.includes("--cleanup-probe")) {
      const readyPath = process.env.PACK_SMOKE_PROBE_READY;
      const termMarker = process.env.PACK_SMOKE_PROBE_TERM_MARKER;
      const probeMode = process.env.PACK_SMOKE_PROBE_MODE;
      if (typeof readyPath !== "string" || !isAbsolute(readyPath)) {
        fail("Cleanup probe requires an absolute PACK_SMOKE_PROBE_READY");
      }
      if (typeof termMarker !== "string" || !isAbsolute(termMarker)) {
        fail("Cleanup probe requires an absolute PACK_SMOKE_PROBE_TERM_MARKER");
      }
      if (!["leader-exit", "output-limit", "signal", "timeout"].includes(probeMode)) {
        fail("Cleanup probe requires a valid PACK_SMOKE_PROBE_MODE");
      }
      await command(
        process.execPath,
        [
          "-e",
          `const { spawn } = require("node:child_process");
const grandchildSource = \`const { writeFileSync } = require("node:fs");
process.on("SIGTERM", () => writeFileSync(process.argv[1], "TERM"));
writeFileSync(process.argv[2], JSON.stringify({ childPid: Number(process.argv[3]), grandchildPid: process.pid, root: process.argv[4] }));
if (process.send) process.send("ready");
setInterval(() => {}, 1000);\`;
const grandchild = spawn(process.execPath, ["-e", grandchildSource, process.argv[3], process.argv[1], String(process.pid), process.argv[2]], {
  stdio: ["ignore", "ignore", "ignore", "ipc"],
});
grandchild.once("message", () => {
  grandchild.disconnect();
  if (process.argv[4] === "leader-exit") {
    grandchild.unref();
    process.exit(0);
  }
  if (process.argv[4] === "output-limit") {
    process.stdout.write("x".repeat(5 * 1024 * 1024));
  }
});
setInterval(() => {}, 1000);`,
          readyPath,
          temporaryRoot,
          termMarker,
          probeMode,
        ],
        {
          cwd: temporaryRoot,
          timeout: configuredTimeout * 2,
        },
      );
      fail("Cleanup probe child exited unexpectedly");
    }

    const tarballRoot = join(temporaryRoot, "tarballs");
    const consumerRoot = join(temporaryRoot, "consumer");
    const privateCache = join(temporaryRoot, "npm-cache");
    const privatePrefix = join(temporaryRoot, "npm-prefix");
    const npmConfigRoot = join(temporaryRoot, "npm-config");
    const userConfig = join(npmConfigRoot, "user.npmrc");
    const globalConfig = join(npmConfigRoot, "global.npmrc");
    mkdirSync(tarballRoot);
    mkdirSync(consumerRoot);
    mkdirSync(privatePrefix);
    mkdirSync(npmConfigRoot);
    writeFileSync(userConfig, "");
    writeFileSync(globalConfig, "");
    const npmHostEnvironment = {
      npm_config_globalconfig: globalConfig,
      npm_config_loglevel: "error",
      npm_config_userconfig: userConfig,
    };
    const npmPrivateEnvironment = {
      ...npmHostEnvironment,
      npm_config_cache: privateCache,
      npm_config_ignore_scripts: "true",
      npm_config_prefix: privatePrefix,
    };
    const canonicalEnvironment = sanitizedEnvironment();
    const npmExecPath = process.env.npm_execpath;
    if (process.platform === "win32" && npmExecPath !== undefined && !existsSync(npmExecPath)) {
      fail(`Windows npm CLI entry does not exist: ${npmExecPath}`);
    }
    const npmPlan = npmExecutionPlan({
      comSpec: canonicalEnvironment.ComSpec,
      npmExecPath,
    });

    const packed = new Map();
    const packageSummaries = [];
    for (const definition of packageDefinitions) {
      const result = await runNpm(
        npmPlan,
        [
          "pack",
          "--json",
          "--ignore-scripts",
          "--workspace",
          definition.name,
          "--pack-destination",
          tarballRoot,
        ],
        { cwd: workspaceRoot, env: npmPrivateEnvironment },
      );
      if (result.stderr !== "") fail(`npm pack wrote to stderr: ${result.stderr}`);
      const parsed = JSON.parse(result.stdout);
      if (!Array.isArray(parsed) || parsed.length !== 1) {
        fail(`npm pack returned an unexpected payload for ${definition.name}`);
      }
      const details = parsed[0];
      packed.set(definition.name, details);
      packageSummaries.push(inspectTarball(definition, details, tarballRoot));
    }

    const sourceLock = JSON.parse(readFileSync(join(workspaceRoot, "package-lock.json"), "utf8"));
    const productionEntries = await seedPrivateCache(
      sourceLock,
      privateCache,
      npmHostEnvironment,
      npmPlan,
    );
    writeConsumerLock(consumerRoot, tarballRoot, packed, productionEntries);
    await runNpm(
      npmPlan,
      ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
      {
        cwd: consumerRoot,
        env: { ...npmPrivateEnvironment, npm_config_offline: "true" },
        timeout: 120_000,
      },
    );
    const binaryExecutable = await exerciseConsumer(consumerRoot);
    assertRunActive();
    const consumerLock = JSON.parse(readFileSync(join(consumerRoot, "package-lock.json"), "utf8"));
    const licenses = installedProductionLicenses(consumerRoot, consumerLock);
    const licenseDocument = renderLicenseDocument(licenses);
    if (process.argv.includes("--write-license-doc")) {
      writeFileSync(licenseDocumentPath, licenseDocument);
    } else if (
      !existsSync(licenseDocumentPath) ||
      readFileSync(licenseDocumentPath, "utf8") !== licenseDocument
    ) {
      fail(
        "docs/dependency-licenses.md is stale; regenerate it with " +
        "node tests/package-smoke/pack-smoke.mjs --write-license-doc",
      );
    }

    assertRunActive();
    process.stdout.write(`${JSON.stringify({
      ok: true,
      binaryExecutable,
      commands: ["note", "build-artifact", "verify", "update-data"],
      imports: [
        "@402v/html-kit-core",
        "@402v/html-kit-cli",
        "@402v/theme-402v",
      ],
      packages: packageSummaries,
      productionLicenseCount: licenses.length,
    })}\n`);
  } finally {
    clearTimeout(deadlineTimer);
    await cleanupExactRoot();
    process.removeListener("SIGINT", onSigint);
    process.removeListener("SIGTERM", onSigterm);
    if (shutdownError !== undefined) throw shutdownError;
  }
}

const isMain = process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  try {
    await runPackSmoke();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    process.exitCode = error?.exitCode ?? 1;
  }
}
