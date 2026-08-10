import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { parse } from "acorn";

import {
  loadScriptEntry,
  loadStylesheetEntry,
  loadSvgAsset,
  resolveTrustedEntry,
} from "./assets.mjs";
import { canonicalizeJson, DATA_BLOCK_ID } from "./data-blocks.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";
import {
  readTrustedUtf8,
  resolveTrustedRoot,
} from "./trusted-files.mjs";

const require = createRequire(import.meta.url);
const nativeImport = require("./native-import.cjs");
const manifestInternals = new WeakMap();
let moduleLoadSequence = 0;

const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;
const MAX_DATA_BYTES = 16 * 1024 * 1024;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

const TOP_LEVEL_KEYS = new Set([
  "contractVersion",
  "mode",
  "rootDirectory",
  "metadata",
  "dataBlocks",
  "renderer",
  "styles",
  "scripts",
  "svgAssets",
  "requiredDataBlocks",
  "theme",
]);
const METADATA_KEYS = new Set(["title", "description", "eyebrow", "lang"]);
const DATA_BLOCK_KEYS = new Set(["id", "source"]);
const SVG_ASSET_KEYS = new Set([
  "id",
  "source",
  "title",
  "description",
]);

function fail(code, message, details = undefined, options = undefined) {
  throw new ArtifactBuildError(code, message, details, options);
}

function invalidManifest(message, details = undefined, options = undefined) {
  fail("INVALID_MANIFEST", message, details, options);
}

function stableLabel(value) {
  if (typeof value === "string") return value;
  if (typeof value === "symbol") return value.toString();
  return String(value);
}

function plainRecord(value, label, allowedKeys) {
  if (value === null || typeof value !== "object") {
    invalidManifest(`${label} must be a plain object`);
  }

  let array;
  let descriptors;
  let keys;
  let prototype;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch (cause) {
    invalidManifest(`${label} cannot be inspected safely`, undefined, { cause });
  }
  if (array) invalidManifest(`${label} must be a plain object`);
  if (prototype !== Object.prototype && prototype !== null) {
    invalidManifest(`${label} must be a plain object`);
  }
  for (const key of keys) {
    const property = stableLabel(key);
    if (typeof key !== "string" || !allowedKeys.has(key)) {
      invalidManifest(`${label} contains an unknown property`, { property });
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      invalidManifest(`${label} properties must be enumerable data properties`, {
        property,
      });
    }
  }
  return descriptors;
}

function field(descriptors, key) {
  return descriptors[key]?.value;
}

function denseArray(value, label, maximumItems = undefined) {
  let array;
  let prototype;
  let lengthDescriptor;
  try {
    array = Array.isArray(value);
    if (!array) invalidManifest(`${label} must be an array`);
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) throw cause;
    invalidManifest(`${label} cannot be inspected safely`, undefined, { cause });
  }
  if (prototype !== Array.prototype) invalidManifest(`${label} must be an array`);
  if (
    lengthDescriptor === undefined ||
    "get" in lengthDescriptor ||
    "set" in lengthDescriptor ||
    !Number.isSafeInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    invalidManifest(`${label} has an invalid length`);
  }
  const length = lengthDescriptor.value;
  if (maximumItems !== undefined && length > maximumItems) {
    invalidManifest(`${label} exceeds the maximum item count`, {
      maximum: maximumItems,
    });
  }
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch (cause) {
    invalidManifest(`${label} cannot be inspected safely`, undefined, { cause });
  }
  const allowedKeys = new Set(["length"]);
  const result = [];
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch (cause) {
      invalidManifest(`${label} cannot be inspected safely`, { index }, { cause });
    }
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      invalidManifest(`${label} must be dense and contain only data values`, {
        index,
      });
    }
    result.push(descriptor.value);
  }
  const extra = ownKeys.find((key) => !allowedKeys.has(key));
  if (extra !== undefined) {
    invalidManifest(`${label} must not contain extra properties`, {
      property: stableLabel(extra),
    });
  }
  return result;
}

function stringValue(value, label) {
  if (typeof value !== "string") {
    invalidManifest(`${label} must be a string`);
  }
  return value;
}

function optionalBoundedTheme(value) {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    Buffer.byteLength(value, "utf8") > 256
  ) {
    invalidManifest("theme must be a non-empty string of at most 256 UTF-8 bytes");
  }
  return value;
}

function localPathValue(value, label) {
  const path = stringValue(value, label);
  if (
    path.length === 0 ||
    path.includes("\0") ||
    URL_SCHEME.test(path) ||
    path.startsWith("//")
  ) {
    invalidManifest(`${label} must be a non-empty local path`);
  }
  return path;
}

function contentHash(content) {
  return createHash("sha256").update(content).digest("hex");
}

function isContained(rootPath, candidatePath) {
  const difference = relative(rootPath, candidatePath);
  return (
    difference === "" ||
    (!isAbsolute(difference) &&
      difference !== ".." &&
      !difference.startsWith(`..${sep}`))
  );
}

function posixLabel(rootPath, candidatePath) {
  const difference = relative(rootPath, candidatePath);
  return difference === "" ? "." : difference.split(sep).join("/");
}

function resolveManifestPath(input) {
  const source = localPathValue(input, "manifest path");
  let path;
  let stats;
  try {
    path = realpathSync(resolve(source));
    stats = statSync(path);
  } catch (cause) {
    invalidManifest("Unable to resolve manifest path", undefined, { cause });
  }
  if (!stats.isFile()) invalidManifest("Manifest path must resolve to a file");
  return path;
}

function resolveRootDirectory(manifestDirectory, declaredRoot) {
  if (declaredRoot !== undefined && isAbsolute(declaredRoot)) {
    invalidManifest("rootDirectory must be relative to the manifest directory");
  }
  const source = declaredRoot ?? ".";
  localPathValue(source, "rootDirectory");
  let rootPath;
  let stats;
  try {
    rootPath = realpathSync(resolve(manifestDirectory, source));
    stats = statSync(rootPath);
  } catch (cause) {
    invalidManifest("Unable to resolve rootDirectory", undefined, { cause });
  }
  if (!stats.isDirectory()) invalidManifest("rootDirectory must resolve to a directory");
  if (!isContained(manifestDirectory, rootPath)) {
    invalidManifest("rootDirectory must remain beneath the manifest directory");
  }
  return resolveTrustedRoot(rootPath);
}

function validateSingleFileModule(content, code, label) {
  let program;
  try {
    program = parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch (cause) {
    fail(code, `${label} must be valid ESM`, undefined, { cause });
  }

  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ImportExpression" ||
      node.type === "ExportAllDeclaration" ||
      (node.type === "ExportNamedDeclaration" && node.source !== null)
    ) {
      fail(
        code,
        `${label} dependencies are unsupported for single-file P0 modules`,
      );
    }
    for (const value of Object.values(node)) {
      if (value !== null && typeof value === "object" && typeof value.type === "string") {
        pending.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (
            item !== null &&
            typeof item === "object" &&
            typeof item.type === "string"
          ) {
            pending.push(item);
          }
        }
      }
    }
  }
}

async function importLocalModule(
  rootPath,
  source,
  code,
  label,
  rootIdentity = undefined,
) {
  let before;
  try {
    before = readTrustedUtf8(rootPath, source, {
      maximumBytes: MAX_MANIFEST_BYTES,
      code,
      entryName: label,
      rootIdentity,
    });
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) {
      fail(code, `Unable to load ${label} safely`, undefined, { cause });
    }
    throw cause;
  }
  validateSingleFileModule(before.content, code, label);
  const beforeHash = contentHash(before.bytes);
  const encoded = before.bytes.toString("base64");
  moduleLoadSequence += 1;
  const url = `data:text/javascript;base64,${encoded}#sha256=${beforeHash}&load=${moduleLoadSequence}`;
  let namespace;
  try {
    namespace = await nativeImport(url);
  } catch (cause) {
    fail(code, `Unable to import ${label}`, undefined, { cause });
  }

  let after;
  try {
    after = readTrustedUtf8(rootPath, source, {
      maximumBytes: MAX_MANIFEST_BYTES,
      code,
      entryName: label,
      rootIdentity,
    });
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) {
      fail(code, `${label} changed while importing`, undefined, { cause });
    }
    throw cause;
  }
  if (after.path !== before.path || contentHash(after.bytes) !== beforeHash) {
    fail(code, `${label} changed while importing`);
  }
  return namespace;
}

function validateMetadata(value) {
  const descriptors = plainRecord(value, "metadata", METADATA_KEYS);
  for (const key of METADATA_KEYS) {
    if (descriptors[key] === undefined) {
      invalidManifest("metadata is missing a required property", { property: key });
    }
  }
  return Object.freeze({
    title: stringValue(field(descriptors, "title"), "metadata.title"),
    description: stringValue(
      field(descriptors, "description"),
      "metadata.description",
    ),
    eyebrow: stringValue(field(descriptors, "eyebrow"), "metadata.eyebrow"),
    lang: stringValue(field(descriptors, "lang"), "metadata.lang"),
  });
}

function validateId(value, label) {
  if (typeof value !== "string" || !DATA_BLOCK_ID.test(value)) {
    invalidManifest(`${label} must match DATA_BLOCK_ID`);
  }
  return value;
}

function uniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    if (ids.has(item.id)) {
      invalidManifest(`${label} ids must be unique`, { id: item.id });
    }
    ids.add(item.id);
  }
  return ids;
}

function normalizeDataBlocks(value, rootPath, rootIdentity) {
  const rawDefinitions = denseArray(
    value,
    "dataBlocks",
    ARTIFACT_RESOURCE_LIMITS.dataBlocks,
  );
  const definitions = rawDefinitions.map(
    (definition, index) => {
      const label = `dataBlocks[${index}]`;
      const descriptors = plainRecord(definition, label, DATA_BLOCK_KEYS);
      const id = validateId(field(descriptors, "id"), `${label}.id`);
      const source = localPathValue(field(descriptors, "source"), `${label}.source`);
      return { id, source };
    },
  );
  uniqueIds(definitions, "dataBlocks");
  const normalized = definitions.map(({ id, source }) =>
      Object.freeze({
        id,
        source: resolveTrustedEntry(rootPath, source, { rootIdentity }).label,
      }),
    );
  return Object.freeze(normalized);
}

function normalizeStringEntries(value, label, rootPath, rootIdentity) {
  const rawEntries = denseArray(
    value,
    label,
    ARTIFACT_RESOURCE_LIMITS[label],
  );
  const normalized = rawEntries.map((source, index) => {
      const normalized = localPathValue(source, `${label}[${index}]`);
      return resolveTrustedEntry(rootPath, normalized, { rootIdentity }).label;
    });
  return Object.freeze(normalized);
}

function normalizeSvgAssets(value, rootPath, rootIdentity) {
  const rawDefinitions = denseArray(
    value,
    "svgAssets",
    ARTIFACT_RESOURCE_LIMITS.svgAssets,
  );
  const definitions = rawDefinitions.map(
    (definition, index) => {
      const label = `svgAssets[${index}]`;
      const descriptors = plainRecord(definition, label, SVG_ASSET_KEYS);
      const id = validateId(field(descriptors, "id"), `${label}.id`);
      const source = localPathValue(field(descriptors, "source"), `${label}.source`);
      const normalized = { id, source };
      for (const key of ["title", "description"]) {
        if (descriptors[key] !== undefined) {
          normalized[key] = stringValue(field(descriptors, key), `${label}.${key}`);
        }
      }
      return normalized;
    },
  );
  uniqueIds(definitions, "svgAssets");
  const normalized = definitions.map((definition) =>
      Object.freeze({
        ...definition,
        source: resolveTrustedEntry(rootPath, definition.source, {
          rootIdentity,
        }).label,
      }),
    );
  return Object.freeze(normalized);
}

function normalizeRequiredBlocks(value, availableIds) {
  const required = denseArray(
    value,
    "requiredDataBlocks",
    ARTIFACT_RESOURCE_LIMITS.dataBlocks,
  ).map((id, index) => validateId(id, `requiredDataBlocks[${index}]`));
  const seen = new Set();
  for (const id of required) {
    if (seen.has(id)) {
      invalidManifest("requiredDataBlocks must not contain duplicates", { id });
    }
    if (!availableIds.has(id)) {
      invalidManifest("requiredDataBlocks must reference declared data blocks", {
        id,
      });
    }
    seen.add(id);
  }
  return Object.freeze(required);
}

function createNodeBudget() {
  return {
    maximum: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
    remaining: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
  };
}

function loadCanonicalData(
  rootPath,
  rootIdentity,
  definitions,
  nodeBudget = createNodeBudget(),
) {
  const data = new Map();
  let rawBytes = 0;
  for (const definition of definitions) {
    const { byteLength, content } = readTrustedUtf8(rootPath, definition.source, {
      maximumBytes: MAX_DATA_BYTES,
      code: "INVALID_DATA_BLOCK",
      entryName: `data block ${definition.id}`,
      rootIdentity,
    });
    rawBytes += byteLength;
    if (rawBytes > ARTIFACT_RESOURCE_LIMITS.rawJsonBytes) {
      fail("INVALID_DATA_BLOCK", "Data block sources exceed the aggregate byte budget", {
        maximumBytes: ARTIFACT_RESOURCE_LIMITS.rawJsonBytes,
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (cause) {
      fail(
        "INVALID_DATA_BLOCK",
        "Data block source must contain strict JSON",
        { id: definition.id, source: definition.source },
        { cause },
      );
    }
    const canonical = canonicalizeJson(parsed, { nodeBudget });
    data.set(definition.id, canonical);
  }
  return data;
}

function loadAggregateAssets(items, loader, maximumBytes, code, label) {
  const outputs = [];
  let totalBytes = 0;
  for (const item of items) {
    const loaded = loader(item);
    totalBytes += loaded.byteLength;
    if (totalBytes > maximumBytes) {
      fail(code, `${label} exceed the aggregate byte budget`, { maximumBytes });
    }
    const { byteLength: _byteLength, ...output } = loaded;
    outputs.push(output);
  }
  return outputs;
}

export function getArtifactManifestInternals(manifest) {
  if (
    manifest === null ||
    (typeof manifest !== "object" && typeof manifest !== "function")
  ) {
    return undefined;
  }
  return manifestInternals.get(manifest);
}

export async function loadArtifactManifest(manifestInput) {
  const manifestPath = resolveManifestPath(manifestInput);
  const manifestDirectory = dirname(manifestPath);
  const namespace = await importLocalModule(
    manifestDirectory,
    basename(manifestPath),
    "INVALID_MANIFEST",
    "artifact manifest",
  );
  const descriptors = plainRecord(
    namespace.default,
    "artifact manifest",
    TOP_LEVEL_KEYS,
  );

  if (field(descriptors, "contractVersion") !== 2) {
    invalidManifest("contractVersion must be 2");
  }
  if (field(descriptors, "mode") !== "interactive") {
    invalidManifest('mode must be exactly "interactive"');
  }

  const rootDeclaration =
    descriptors.rootDirectory === undefined
      ? undefined
      : localPathValue(field(descriptors, "rootDirectory"), "rootDirectory");
  const trustedRoot = resolveRootDirectory(manifestDirectory, rootDeclaration);
  const rootPath = trustedRoot.path;
  const rootIdentity = trustedRoot.identity;
  const metadata = validateMetadata(field(descriptors, "metadata"));
  const theme = optionalBoundedTheme(field(descriptors, "theme"));
  const dataBlocks = normalizeDataBlocks(
    field(descriptors, "dataBlocks"),
    rootPath,
    rootIdentity,
  );
  const dataIds = uniqueIds(dataBlocks, "dataBlocks");
  const rendererSource = localPathValue(field(descriptors, "renderer"), "renderer");
  const renderer = resolveTrustedEntry(rootPath, rendererSource, {
    rootIdentity,
  }).label;
  const styles = normalizeStringEntries(
    field(descriptors, "styles"),
    "styles",
    rootPath,
    rootIdentity,
  );
  const scripts = normalizeStringEntries(
    field(descriptors, "scripts"),
    "scripts",
    rootPath,
    rootIdentity,
  );
  const svgAssets = normalizeSvgAssets(
    field(descriptors, "svgAssets"),
    rootPath,
    rootIdentity,
  );
  uniqueIds(svgAssets, "svgAssets");
  const requiredDataBlocks = normalizeRequiredBlocks(
    field(descriptors, "requiredDataBlocks"),
    dataIds,
  );
  const manifest = {
    contractVersion: 2,
    mode: "interactive",
    rootDirectory: posixLabel(manifestDirectory, rootPath),
    metadata,
    dataBlocks,
    renderer,
    styles,
    scripts,
    svgAssets,
    requiredDataBlocks,
    ...(theme === undefined ? {} : { theme }),
  };

  manifestInternals.set(
    manifest,
    Object.freeze({
      loadData: (nodeBudget) =>
        loadCanonicalData(rootPath, rootIdentity, dataBlocks, nodeBudget),
      loadStyles: () =>
        loadAggregateAssets(
          styles,
          (source) =>
            loadStylesheetEntry(rootPath, source, {
              includeByteLength: true,
              rootIdentity,
            }),
          ARTIFACT_RESOURCE_LIMITS.stylesheetBytes,
          "INVALID_STYLESHEET",
          "Stylesheet entries",
        ),
      loadScripts: () =>
        loadAggregateAssets(
          scripts,
          (source) =>
            loadScriptEntry(rootPath, source, {
              includeByteLength: true,
              rootIdentity,
            }),
          ARTIFACT_RESOURCE_LIMITS.scriptBytes,
          "INVALID_JAVASCRIPT",
          "JavaScript entries",
        ),
      loadSvg: () =>
        loadAggregateAssets(
          svgAssets,
          (definition) =>
            loadSvgAsset(rootPath, definition, {
              includeByteLength: true,
              rootIdentity,
            }),
          ARTIFACT_RESOURCE_LIMITS.svgBytes,
          "UNSAFE_SVG",
          "SVG assets",
        ),
      importRenderer: async () => {
        return importLocalModule(
          rootPath,
          renderer,
          "INVALID_RENDERER_RESULT",
          `renderer ${renderer}`,
          rootIdentity,
        );
      },
    }),
  );

  return Object.freeze(manifest);
}
