import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, statSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

import { assembleArtifactV2 } from "./document-v2.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { parseMarkdownDocument } from "./frontmatter.mjs";
import { atomicWriteUtf8, readUtf8File } from "./io.mjs";
import { renderMarkdown } from "./render-markdown.mjs";
import { renderThemeV1 } from "./theme-contract.mjs";
import { verifyArtifactHtml } from "./verify.mjs";

const BUILD_KEYS = new Set(["inputPath", "outputPath", "force", "theme"]);
const THEME_KEYS = new Set([
  "themeContractVersion",
  "id",
  "version",
  "displayName",
  "render",
]);
const THEME_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,62})$/;
const THEME_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

function fail(code, message, details = undefined, options = undefined) {
  throw new ArtifactBuildError(code, message, details, options);
}

function inspectRecord(value, allowedKeys, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be a plain object`);
  }

  let descriptors;
  let keys;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value);
  } catch (cause) {
    fail(code, `${label} cannot be inspected safely`, undefined, { cause });
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain object`);
  }

  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !allowedKeys.has(key) ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail(code, `${label} contains an invalid property`, {
        property: typeof key === "symbol" ? key.toString() : String(key),
      });
    }
    values[key] = descriptor.value;
  }
  return { keys, values };
}

function inspectBuildOptions(options) {
  return inspectRecord(
    options,
    BUILD_KEYS,
    "INVALID_BUILD_OPTIONS",
    "Build options",
  ).values;
}

function boundedNonEmptyString(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximumBytes
  );
}

function inspectTheme(theme) {
  const { keys, values } = inspectRecord(
    theme,
    THEME_KEYS,
    "INVALID_THEME",
    "Theme",
  );
  if (
    keys.length !== THEME_KEYS.size ||
    values.themeContractVersion !== 1 ||
    !boundedNonEmptyString(values.id, 128) ||
    !THEME_ID.test(values.id) ||
    !boundedNonEmptyString(values.version, 128) ||
    !THEME_VERSION.test(values.version) ||
    !boundedNonEmptyString(values.displayName, 256) ||
    typeof values.render !== "function"
  ) {
    fail("INVALID_THEME", "Theme does not satisfy Theme Contract v1");
  }

  const snapshot = Object.freeze({
    themeContractVersion: 1,
    id: values.id,
    version: values.version,
    displayName: values.displayName,
    render: values.render,
  });
  return {
    identity: Object.freeze({ id: values.id, version: values.version }),
    snapshot,
  };
}

function pathValue(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("INVALID_BUILD_OPTIONS", `${label} must be a non-empty local filesystem path`);
  }
  return resolve(value);
}

function forceValue(value) {
  if (value === undefined) return false;
  if (typeof value !== "boolean") {
    fail("INVALID_BUILD_OPTIONS", "force must be a boolean");
  }
  return value;
}

function inputStats(inputPath) {
  try {
    return statSync(inputPath);
  } catch (cause) {
    if (cause?.code === "ENOENT") {
      fail("INVALID_BUILD_OPTIONS", "Markdown input was not found", {
        input: inputPath,
      });
    }
    fail(
      "INVALID_BUILD_OPTIONS",
      "Unable to inspect Markdown input",
      { input: inputPath },
      { cause },
    );
  }
}

function assertDistinctPaths(inputPath, outputPath, input) {
  if (inputPath === outputPath) {
    fail("INVALID_BUILD_OPTIONS", "Input and output paths must differ", {
      input: inputPath,
      output: outputPath,
    });
  }

  try {
    const output = statSync(outputPath);
    if (input.dev === output.dev && input.ino === output.ino) {
      fail("INVALID_BUILD_OPTIONS", "Input and output paths must not alias", {
        input: inputPath,
        output: outputPath,
      });
    }
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) throw cause;
    if (cause?.code !== "ENOENT") {
      fail(
        "INVALID_BUILD_OPTIONS",
        "Unable to verify that input and output paths differ",
        { input: inputPath, output: outputPath },
        { cause },
      );
    }
  }
}

function assertWritableDestination(outputPath, force) {
  if (force) return;
  try {
    lstatSync(outputPath);
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    fail(
      "ATOMIC_WRITE_FAILED",
      "Unable to inspect output destination",
      { output: outputPath },
      { cause },
    );
  }
  fail("OUTPUT_EXISTS", "Output already exists; pass force to replace it", {
    output: outputPath,
  });
}

function prepareOutputDirectory(outputPath) {
  try {
    mkdirSync(dirname(outputPath), { recursive: true });
  } catch (cause) {
    fail(
      "ATOMIC_WRITE_FAILED",
      "Unable to prepare the output directory",
      { output: outputPath },
      { cause },
    );
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export async function buildNote(options) {
  const inspected = inspectBuildOptions(options);
  const { identity: themeIdentity, snapshot: theme } = inspectTheme(
    inspected.theme,
  );
  const inputPath = pathValue(inspected.inputPath, "inputPath");
  const outputPath = pathValue(inspected.outputPath, "outputPath");
  const force = forceValue(inspected.force);

  if (extname(inputPath).toLowerCase() !== ".md") {
    fail("INVALID_BUILD_OPTIONS", "Markdown input must be a .md file");
  }
  const stats = inputStats(inputPath);
  assertDistinctPaths(inputPath, outputPath, stats);
  assertWritableDestination(outputPath, force);

  const source = readUtf8File(inputPath).content;
  const { body, metadata } = parseMarkdownDocument(source);
  const { articleHtml, headings } = renderMarkdown(body, {
    sourceDirectory: dirname(inputPath),
  });
  const themeOutput = renderThemeV1(theme, {
    mode: "note",
    metadata,
    content: { articleHtml, headings },
  });
  const html = assembleArtifactV2({
    mode: "note",
    metadata,
    theme: themeIdentity,
    themeOutput,
    dataBlocks: new Map(),
    consumerScripts: [],
  });
  const verification = verifyArtifactHtml(html);

  prepareOutputDirectory(outputPath);
  atomicWriteUtf8(outputPath, html, { overwrite: force });
  return {
    ok: true,
    contractVersion: 2,
    mode: "note",
    output: outputPath,
    title: metadata.title,
    bytes: Buffer.byteLength(html, "utf8"),
    sourceHash: verification.sourceHash,
    outputHash: sha256(html),
    dataBlockIds: verification.dataBlockIds,
    theme: themeIdentity,
  };
}
