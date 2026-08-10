import { spawnSync } from "node:child_process";
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
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

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
  ["NEXT_PUBLIC_", /NEXT_PUBLIC_/gu],
  ["developer home path", /\/(?:Users|home)\/[A-Za-z0-9._-]+\//gu],
  ["Windows developer home path", /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/gu],
  ["local file URL", /file:\/\/\/(?:Users|home|private|tmp|var)\//gu],
  ["temporary host path", /\/(?:private\/)?tmp\/[A-Za-z0-9._-]+/gu],
  ["macOS temporary host path", /\/var\/folders\/[A-Za-z0-9._/-]+/gu],
  ["private key", /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/gu],
  ["AWS access key", /AKIA[0-9A-Z]{16}/gu],
  ["GitHub token", /gh[opusr]_[A-Za-z0-9]{20,}/gu],
  ["Slack token", /xox[a-z]-[A-Za-z0-9-]{10,}/giu],
  [
    "literal credential",
    /(?:api[_-]?key|password|secret)\s*[:=]\s*["'][^"'\n$]{8,}["']/giu,
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

function command(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    cwd: options.cwd ?? workspaceRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_PATH: "",
      NO_COLOR: "1",
      ...options.env,
    },
    timeout: options.timeout ?? 120_000,
  });
  if (result.error !== undefined) {
    fail(`${executable} could not run: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(
      `${executable} ${args.join(" ")} exited ${result.status}\n` +
      `${result.stdout}${result.stderr}`,
    );
  }
  return result;
}

function jsonCommand(executable, args, cwd) {
  const result = command(executable, args, { cwd });
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

function readTarEntries(tarballPath) {
  const archive = gunzipSync(readFileSync(tarballPath));
  const entries = [];
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
    } else if (type !== "5") {
      fail(`Unsupported tar entry type ${type} for ${path}`);
    }
    offset = bodyStart + Math.ceil(size / 512) * 512;
  }
  return entries;
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
  let source = content.toString("utf8");
  if (packageName === "@402v/theme-402v" && reviewedThemeBrandFiles.has(path)) {
    if (source.split(reviewedThemeBrandAnchor).length !== 2) {
      fail(`Reviewed theme brand href changed in ${path}`);
    }
    reviewedBrandFiles.add(path);
    source = source.replace(reviewedThemeBrandAnchor, "");
  }
  if (/402v\.com/iu.test(source)) {
    fail(`Unreviewed 402v.com occurrence in ${packageName}/${path}`);
  }
  for (const [label, pattern] of forbiddenPayloadPatterns) {
    pattern.lastIndex = 0;
    if (pattern.test(source)) fail(`${label} found in ${packageName}/${path}`);
  }
}

function inspectTarball(definition, details, tarballRoot) {
  if (details.name !== definition.name) {
    fail(`npm pack returned ${details.name} for ${definition.name}`);
  }
  const expected = [...definition.files].sort();
  const reported = details.files.map(({ path }) => path).sort();
  if (JSON.stringify(reported) !== JSON.stringify(expected)) {
    fail(
      `${definition.name} tarball allowlist mismatch\n` +
      `expected: ${expected.join(", ")}\nactual: ${reported.join(", ")}`,
    );
  }
  for (const path of reported) assertSafeArchivePath(path);

  const tarballPath = join(tarballRoot, details.filename);
  const entries = readTarEntries(tarballPath);
  const reviewedBrandFiles = new Set();
  const payloadPaths = [];
  for (const entry of entries) {
    if (!entry.path.startsWith("package/")) {
      fail(`Tarball entry lacks package/ prefix: ${entry.path}`);
    }
    const path = entry.path.slice("package/".length);
    assertSafeArchivePath(path);
    payloadPaths.push(path);
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

function seedPrivateCache(sourceLock, privateCache) {
  const hostCache = command("npm", ["config", "get", "cache"]).stdout.trim();
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
`,
  );
  return fixtureRoot;
}

function exerciseConsumer(consumerRoot) {
  for (const name of packageNames) {
    const packageRoot = realpathSync(join(consumerRoot, "node_modules", ...name.split("/")));
    if (!contained(consumerRoot, packageRoot)) {
      fail(`Installed package resolves outside the clean consumer: ${name}`);
    }
  }
  const binary = join(
    consumerRoot,
    "node_modules",
    ".bin",
    process.platform === "win32" ? "402v-html-kit.cmd" : "402v-html-kit",
  );
  const resolvedBinary = realpathSync(binary);
  if (!contained(consumerRoot, resolvedBinary)) fail("CLI binary resolves outside consumer");
  if (process.platform !== "win32" && (statSync(resolvedBinary).mode & 0o111) === 0) {
    fail("Installed CLI is not executable");
  }

  const fixtureRoot = writeConsumerFixtures(consumerRoot);
  jsonCommand(binary, ["build", "note.md", "--output", "note.html"], fixtureRoot);
  jsonCommand(binary, ["verify", "note.html"], fixtureRoot);
  jsonCommand(
    binary,
    ["build-artifact", "artifact.mjs", "--output", "artifact.html"],
    fixtureRoot,
  );
  jsonCommand(binary, ["verify", "artifact.html", "--required-block", "registry"], fixtureRoot);
  jsonCommand(
    binary,
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
  );
  jsonCommand(binary, ["verify", "artifact.html", "--required-block", "registry"], fixtureRoot);
  command(process.execPath, [join(consumerRoot, "imports.mjs")], { cwd: consumerRoot });
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

let temporaryRoot;
try {
  temporaryRoot = mkdtempSync(join(tmpdir(), "402v-pack-smoke-"));
  const tarballRoot = join(temporaryRoot, "tarballs");
  const consumerRoot = join(temporaryRoot, "consumer");
  const privateCache = join(temporaryRoot, "npm-cache");
  mkdirSync(tarballRoot);
  mkdirSync(consumerRoot);

  const packed = new Map();
  const packageSummaries = [];
  for (const definition of packageDefinitions) {
    const result = command(
      "npm",
      [
        "pack",
        "--json",
        "--workspace",
        definition.name,
        "--pack-destination",
        tarballRoot,
      ],
      {
        cwd: workspaceRoot,
        env: { npm_config_cache: privateCache, npm_config_loglevel: "error" },
      },
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
  const productionEntries = seedPrivateCache(sourceLock, privateCache);
  writeConsumerLock(consumerRoot, tarballRoot, packed, productionEntries);
  command(
    "npm",
    ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
    {
      cwd: consumerRoot,
      env: { npm_config_cache: privateCache, npm_config_offline: "true" },
      timeout: 180_000,
    },
  );
  const binaryExecutable = exerciseConsumer(consumerRoot);
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
  if (temporaryRoot !== undefined) {
    // Windows can preserve an inherited read-only bit on cached content.
    try {
      chmodSync(temporaryRoot, 0o700);
    } catch {
      // Cleanup below remains authoritative.
    }
    rmSync(temporaryRoot, { recursive: true, force: true, maxRetries: 3 });
  }
}
