import {
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  ArtifactBuildError,
  buildInteractiveArtifact,
  buildNote,
  renderThemeV1,
  verifyArtifact,
} from "@402v/html-kit-core";

import { loadTheme, resolveThemeSelection } from "./theme-loader.mjs";

const MAX_STRING_BYTES = 4_096;
const MAX_REQUEST_STRING_BYTES = 32 * 1024;
const MAX_DATA_BLOCK_ID_BYTES = 256;
const MAX_REQUIRED_BLOCK_BYTES = 8 * 1024;
const COMMAND_KEYS = Object.freeze({
  init: new Set(["baseDirectory", "directory", "force", "theme", "title"]),
  build: new Set(["baseDirectory", "force", "inputPath", "outputPath", "theme"]),
  "build-artifact": new Set([
    "baseDirectory",
    "force",
    "manifestPath",
    "outputPath",
    "preserveDataFrom",
    "theme",
  ]),
  "update-data": new Set([
    "artifactPath",
    "baseDirectory",
    "force",
    "id",
    "inputPath",
    "manifestPath",
    "outputPath",
    "theme",
    "upgradeContract",
  ]),
  verify: new Set(["path", "requiredDataBlocks"]),
});

let handled = false;
const send = process.send?.bind(process);

process.once("message", async (request) => {
  if (handled || send === undefined) return;
  handled = true;
  const token = requestToken(request);
  if (token === undefined) return;
  try {
    const { command, options } = inspectRequest(request);
    const result = await execute(command, options);
    sendEnvelope({ token, kind: "result", payload: result });
  } catch (error) {
    const normalized =
      error instanceof ArtifactBuildError
        ? error.toJSON()
        : new ArtifactBuildError(
            "UNEXPECTED_CLI_ERROR",
            "402v HTML Kit command failed unexpectedly",
          ).toJSON();
    sendEnvelope({ token, kind: "error", payload: normalized.error });
  }
});

function fail(code, message) {
  throw new ArtifactBuildError(code, message);
}

function requestToken(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(value, "token");
  return descriptor?.enumerable === true &&
    Object.prototype.hasOwnProperty.call(descriptor, "value") &&
    typeof descriptor.value === "string" &&
    /^[a-f0-9]{64}$/.test(descriptor.value)
    ? descriptor.value
    : undefined;
}

function plainValues(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_CLI_ARGUMENTS", `${label} must be a plain object`);
  }
  let prototype;
  let keys;
  let descriptors;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("INVALID_CLI_ARGUMENTS", `${label} could not be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_CLI_ARGUMENTS", `${label} must be a plain object`);
  }
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("INVALID_CLI_ARGUMENTS", `${label} contains an invalid property`);
    }
    values[key] = descriptor.value;
  }
  return values;
}

function inspectRequest(request) {
  const envelope = plainValues(
    request,
    new Set(["token", "command", "options"]),
    "Worker request",
  );
  if (typeof envelope.command !== "string" || !(envelope.command in COMMAND_KEYS)) {
    fail("INVALID_CLI_ARGUMENTS", "Worker request contains an unsupported command");
  }
  const options = plainValues(
    envelope.options,
    COMMAND_KEYS[envelope.command],
    "Worker options",
  );
  let aggregateBytes = 0;
  for (const value of Object.values(options)) {
    if (typeof value === "string") {
      aggregateBytes += Buffer.byteLength(value, "utf8");
    } else if (Array.isArray(value)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          aggregateBytes += Buffer.byteLength(entry, "utf8");
        }
      }
    }
  }
  if (aggregateBytes > MAX_REQUEST_STRING_BYTES) {
    fail("INVALID_CLI_ARGUMENTS", "Worker request exceeds its aggregate string limit");
  }
  return {
    command: envelope.command,
    options,
  };
}

function string(value, label, optional = false, maximumBytes = MAX_STRING_BYTES) {
  if (optional && value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    fail("INVALID_CLI_ARGUMENTS", `${label} must be a bounded non-empty string`);
  }
  return value;
}

function boolean(value, label) {
  if (typeof value !== "boolean") {
    fail("INVALID_CLI_ARGUMENTS", `${label} must be a boolean`);
  }
  return value;
}

function assertExactKeys(options, required, optional = []) {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(options);
  if (
    required.some((key) => !Object.prototype.hasOwnProperty.call(options, key)) ||
    keys.some((key) => !allowed.has(key))
  ) {
    fail("INVALID_CLI_ARGUMENTS", "Worker options do not match the command shape");
  }
}

async function selectedTheme(options, manifest = undefined) {
  const flag = string(options.theme, "theme", true);
  const specifier = resolveThemeSelection({ flag, manifest });
  const theme = await loadTheme(
    specifier,
    string(options.baseDirectory, "baseDirectory"),
  );
  return { specifier, theme };
}

function themeIdentity(theme) {
  const id = Object.getOwnPropertyDescriptor(theme, "id")?.value;
  const version = Object.getOwnPropertyDescriptor(theme, "version")?.value;
  return Object.freeze({ id, version });
}

async function execute(command, options) {
  if (command === "init") return initialize(options);
  if (command === "build") return build(options);
  if (command === "build-artifact") return buildArtifact(options);
  if (command === "update-data") {
    assertExactKeys(
      options,
      ["artifactPath", "baseDirectory", "force", "id", "inputPath", "manifestPath"],
      ["outputPath", "theme", "upgradeContract"],
    );
    string(options.artifactPath, "artifactPath");
    string(options.baseDirectory, "baseDirectory");
    boolean(options.force, "force");
    string(options.id, "id", false, MAX_DATA_BLOCK_ID_BYTES);
    string(options.inputPath, "inputPath");
    string(options.manifestPath, "manifestPath");
    string(options.outputPath, "outputPath", true);
    string(options.theme, "theme", true, 256);
    if (
      options.upgradeContract !== undefined &&
      options.upgradeContract !== "2"
    ) {
      fail("INVALID_CLI_ARGUMENTS", "upgradeContract only accepts 2");
    }
    fail(
      "COMMAND_UNAVAILABLE",
      "update-data is unavailable until contract upgrade support is installed",
    );
  }
  return verify(options);
}

async function build(options) {
  assertExactKeys(
    options,
    ["baseDirectory", "force", "inputPath", "outputPath"],
    ["theme"],
  );
  const selected = await selectedTheme(options);
  const result = await buildNote({
    inputPath: string(options.inputPath, "inputPath"),
    outputPath: string(options.outputPath, "outputPath"),
    force: boolean(options.force, "force"),
    theme: selected.theme,
  });
  return { command: "build", ...result };
}

async function manifestTheme(manifestInput) {
  const requested = resolve(string(manifestInput, "manifestPath"));
  let path;
  let before;
  try {
    path = realpathSync(requested);
    before = statSync(path, { bigint: true });
  } catch {
    fail("INVALID_MANIFEST", "Manifest path could not be resolved");
  }
  if (!before.isFile()) fail("INVALID_MANIFEST", "Manifest path must resolve to a file");
  let namespace;
  try {
    namespace = await import(pathToFileURL(path).href);
  } catch {
    fail("INVALID_MANIFEST", "Artifact manifest could not be imported");
  }
  let after;
  let canonical;
  try {
    canonical = realpathSync(requested);
    after = statSync(canonical, { bigint: true });
  } catch {
    fail("INVALID_MANIFEST", "Manifest path changed during import");
  }
  if (
    canonical !== path ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    !after.isFile()
  ) {
    fail("INVALID_MANIFEST", "Manifest path changed during import");
  }
  const exported = namespace.default;
  if (exported === null || typeof exported !== "object" || Array.isArray(exported)) {
    return undefined;
  }
  const descriptor = Object.getOwnPropertyDescriptor(exported, "theme");
  if (descriptor === undefined) return undefined;
  if (
    descriptor.enumerable !== true ||
    !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
    typeof descriptor.value !== "string" ||
    descriptor.value.length === 0 ||
    descriptor.value.includes("\0") ||
    Buffer.byteLength(descriptor.value, "utf8") > 256
  ) {
    fail("INVALID_MANIFEST", "Manifest theme metadata is invalid");
  }
  return descriptor.value;
}

async function buildArtifact(options) {
  assertExactKeys(
    options,
    ["baseDirectory", "force", "manifestPath", "outputPath"],
    ["preserveDataFrom", "theme"],
  );
  if (options.preserveDataFrom !== undefined) {
    string(options.preserveDataFrom, "preserveDataFrom");
    fail(
      "COMMAND_UNAVAILABLE",
      "--preserve-data-from is unavailable until contract upgrade support is installed",
    );
  }
  const manifestPath = string(options.manifestPath, "manifestPath");
  const metadataTheme = await manifestTheme(manifestPath);
  const selected = await selectedTheme(options, metadataTheme);
  const result = await buildInteractiveArtifact({
    manifestPath,
    outputPath: string(options.outputPath, "outputPath"),
    force: boolean(options.force, "force"),
    theme: selected.theme,
  });
  return { command: "build-artifact", ...result };
}

function verify(options) {
  assertExactKeys(options, ["path", "requiredDataBlocks"]);
  const requiredDataBlocks = options.requiredDataBlocks;
  if (
    !Array.isArray(requiredDataBlocks) ||
    requiredDataBlocks.length > 32 ||
    requiredDataBlocks.some(
      (value) =>
        typeof value !== "string" ||
        value.length === 0 ||
        value.includes("\0") ||
        Buffer.byteLength(value, "utf8") > MAX_DATA_BLOCK_ID_BYTES,
    ) ||
    new Set(requiredDataBlocks).size !== requiredDataBlocks.length ||
    requiredDataBlocks.reduce(
      (total, value) => total + Buffer.byteLength(value, "utf8"),
      0,
    ) > MAX_REQUIRED_BLOCK_BYTES
  ) {
    fail("INVALID_CLI_ARGUMENTS", "requiredDataBlocks must be a bounded string array");
  }
  const result = verifyArtifact({
    path: string(options.path, "path"),
    requiredDataBlocks,
  });
  return { command: "verify", ...result };
}

async function initialize(options) {
  assertExactKeys(
    options,
    ["baseDirectory", "directory", "force", "title"],
    ["theme"],
  );
  const title = string(options.title, "title").trim();
  if (title.length === 0 || /[\u0000-\u001f\u007f]/.test(title)) {
    fail("INVALID_CLI_ARGUMENTS", "title contains unsupported control characters");
  }
  const force = boolean(options.force, "force");
  const selected = await selectedTheme(options);
  renderThemeV1(selected.theme, {
    mode: "note",
    metadata: { title, description: "", eyebrow: "", lang: "en" },
    content: { articleHtml: "<p>Starter</p>", headings: [] },
  });

  const directory = resolve(string(options.directory, "directory"));
  prepareStarterDirectory(directory);
  const files = new Map([
    ["note.md", starterMarkdown(title)],
    ["artifact.mjs", starterManifest(title, selected.specifier)],
    ["renderer.mjs", starterRenderer()],
  ]);
  if (!force) {
    for (const name of files.keys()) {
      if (existsSync(resolve(directory, name))) {
        fail("OUTPUT_EXISTS", "Starter output already exists; pass force to replace it");
      }
    }
  }
  for (const [name, content] of files) {
    atomicContainedWrite(directory, name, content, force);
  }
  return {
    ok: true,
    command: "init",
    directory,
    files: [...files.keys()],
    theme: themeIdentity(selected.theme),
  };
}

function contained(root, candidate) {
  const difference = relative(root, candidate);
  return difference === "" ||
    (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`));
}

function prepareStarterDirectory(directory) {
  try {
    mkdirSync(directory, { recursive: true });
    const canonical = realpathSync(directory);
    if (canonical !== directory || !statSync(canonical).isDirectory()) {
      fail("INVALID_CLI_ARGUMENTS", "Starter directory must be a canonical local directory");
    }
  } catch (error) {
    if (error instanceof ArtifactBuildError) throw error;
    fail("ATOMIC_WRITE_FAILED", "Starter directory could not be prepared");
  }
}

function atomicContainedWrite(directory, name, content, force) {
  const canonical = realpathSync(directory);
  const destination = resolve(canonical, name);
  if (!contained(canonical, destination) || dirname(destination) !== canonical) {
    fail("ATOMIC_WRITE_FAILED", "Starter destination escaped its directory");
  }
  const temporary = resolve(
    canonical,
    `.${basename(name)}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, content, "utf8");
    closeSync(descriptor);
    descriptor = undefined;
    if (realpathSync(directory) !== canonical || lstatSync(canonical).isSymbolicLink()) {
      fail("ATOMIC_WRITE_FAILED", "Starter directory changed during write");
    }
    if (force) {
      renameSync(temporary, destination);
    } else {
      linkSync(temporary, destination);
      unlinkSync(temporary);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch {}
    }
    try { unlinkSync(temporary); } catch {}
    if (error instanceof ArtifactBuildError) throw error;
    if (!force && error?.code === "EEXIST") {
      fail("OUTPUT_EXISTS", "Starter output appeared during installation");
    }
    fail("ATOMIC_WRITE_FAILED", "Starter file could not be installed atomically");
  }
}

function starterMarkdown(title) {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: Add one sentence that explains why this note matters.\neyebrow: 402v Knowledge\n---\n\n# ${title}\n\nWrite the core idea here.\n`;
}

function starterManifest(title, theme) {
  return `export default {\n  contractVersion: 2,\n  mode: "interactive",\n  metadata: { title: ${JSON.stringify(title)}, description: "", eyebrow: "402v Knowledge", lang: "en" },\n  dataBlocks: [],\n  renderer: "./renderer.mjs",\n  styles: [],\n  scripts: [],\n  svgAssets: [],\n  requiredDataBlocks: [],\n  theme: ${JSON.stringify(theme)}\n};\n`;
}

function starterRenderer() {
  return 'export function renderArtifact() {\n  return { mainSections: "<main><p>Write the interactive experience here.</p></main>" };\n}\n';
}

function sendEnvelope(envelope) {
  send(envelope, () => {
    try { process.disconnect(); } catch {}
  });
}
