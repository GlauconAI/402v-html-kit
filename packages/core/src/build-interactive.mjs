import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { assembleArtifactV2Unchecked } from "./document-v2.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { renderInteractiveModel } from "./interactive.mjs";
import { atomicWriteUtf8 } from "./io.mjs";
import { loadArtifactManifest } from "./manifest.mjs";
import { renderThemeV1 } from "./theme-contract.mjs";
import { verifyArtifactHtml } from "./verify.mjs";

const BUILD_KEYS = new Set([
  "manifestPath",
  "outputPath",
  "force",
  "theme",
  "verifyDeterminism",
]);
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
  if (value === null || typeof value !== "object") {
    fail(code, `${label} must be a plain object`);
  }
  let array;
  let descriptors;
  let keys;
  let prototype;
  try {
    array = Array.isArray(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
    prototype = Object.getPrototypeOf(value);
  } catch (cause) {
    fail(code, `${label} cannot be inspected safely`, undefined, { cause });
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) {
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
  return {
    identity: Object.freeze({ id: values.id, version: values.version }),
    snapshot: Object.freeze({
      themeContractVersion: 1,
      id: values.id,
      version: values.version,
      displayName: values.displayName,
      render: values.render,
    }),
  };
}

function pathValue(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail("INVALID_BUILD_OPTIONS", `${label} must be a non-empty local filesystem path`);
  }
  return resolve(value);
}

function booleanValue(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    fail("INVALID_BUILD_OPTIONS", `${label} must be a boolean`);
  }
  return value;
}

function assertDistinctPaths(manifestPath, outputPath) {
  if (manifestPath === outputPath) {
    fail("INVALID_BUILD_OPTIONS", "Manifest and output paths must differ", {
      manifest: manifestPath,
      output: outputPath,
    });
  }
  try {
    const manifest = statSync(manifestPath);
    const output = statSync(outputPath);
    if (manifest.dev === output.dev && manifest.ino === output.ino) {
      fail("INVALID_BUILD_OPTIONS", "Manifest and output paths must not alias", {
        manifest: manifestPath,
        output: outputPath,
      });
    }
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) throw cause;
    if (cause?.code !== "ENOENT") {
      fail(
        "INVALID_BUILD_OPTIONS",
        "Unable to verify that manifest and output paths differ",
        { manifest: manifestPath, output: outputPath },
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

function pinOutputParent(outputPath) {
  const requestedParent = dirname(outputPath);
  let canonicalParent;
  let stats;
  try {
    canonicalParent = realpathSync(requestedParent);
    stats = statSync(canonicalParent, { bigint: true });
  } catch (cause) {
    fail(
      "INVALID_BUILD_OPTIONS",
      "Output parent must already resolve to a local directory",
      { output: outputPath },
      { cause },
    );
  }
  if (!stats.isDirectory()) {
    fail("INVALID_BUILD_OPTIONS", "Output parent must resolve to a directory", {
      output: outputPath,
    });
  }
  return Object.freeze({
    requestedParent,
    canonicalParent,
    identity: Object.freeze({ dev: stats.dev, ino: stats.ino }),
    destination: resolve(canonicalParent, basename(outputPath)),
  });
}

function revalidateOutputParent(pin, requestedOutput) {
  let canonicalParent;
  let stats;
  try {
    canonicalParent = realpathSync(pin.requestedParent);
    stats = statSync(canonicalParent, { bigint: true });
  } catch (cause) {
    fail(
      "INVALID_BUILD_OPTIONS",
      "Output parent changed while rendering",
      { output: requestedOutput },
      { cause },
    );
  }
  if (
    !stats.isDirectory() ||
    canonicalParent !== pin.canonicalParent ||
    stats.dev !== pin.identity.dev ||
    stats.ino !== pin.identity.ino
  ) {
    fail("INVALID_BUILD_OPTIONS", "Output parent changed while rendering", {
      output: requestedOutput,
    });
  }
  return pin.destination;
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function sortedEntries(entries) {
  return [...entries].sort((left, right) =>
    left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
  );
}

function preparedSvgRegistry(entries) {
  const registry = {};
  for (const entry of entries) {
    registry[entry.id] = { ...entry };
  }
  return registry;
}

async function renderPipeline(manifestPath, theme, themeIdentity) {
  const manifest = await loadArtifactManifest(manifestPath);
  const model = await renderInteractiveModel(manifest);
  const renderedTheme = renderThemeV1(theme, {
    mode: "interactive",
    metadata: model.metadata,
    content: {
      slots: model.slots,
      svg: preparedSvgRegistry(model.svg),
    },
  });
  const consumerStyles = sortedEntries(model.styles)
    .map((entry) => entry.content)
    .filter((content) => content.length > 0);
  const themeOutput = {
    ...renderedTheme,
    styles: [renderedTheme.styles, ...consumerStyles]
      .filter((content) => content.length > 0)
      .join("\n"),
  };
  const html = assembleArtifactV2Unchecked({
    mode: "interactive",
    metadata: model.metadata,
    theme: themeIdentity,
    themeOutput,
    dataBlocks: model.data,
    consumerScripts: sortedEntries(model.scripts).map((entry) => entry.content),
  });
  return { html, model };
}

export async function buildInteractiveArtifact(options) {
  const inspected = inspectBuildOptions(options);
  const { identity: themeIdentity, snapshot: theme } = inspectTheme(inspected.theme);
  const manifestPath = pathValue(inspected.manifestPath, "manifestPath");
  const outputPath = pathValue(inspected.outputPath, "outputPath");
  const force = booleanValue(inspected.force, false, "force");
  const verifyDeterminism = booleanValue(
    inspected.verifyDeterminism,
    true,
    "verifyDeterminism",
  );

  const outputPin = pinOutputParent(outputPath);
  assertDistinctPaths(manifestPath, outputPin.destination);
  assertWritableDestination(outputPin.destination, force);
  const first = await renderPipeline(manifestPath, theme, themeIdentity);
  if (verifyDeterminism) {
    const second = await renderPipeline(manifestPath, theme, themeIdentity);
    if (second.html !== first.html) {
      fail(
        "NON_DETERMINISTIC_BUILD",
        "Second render did not produce byte-identical HTML",
      );
    }
  }
  const verification = verifyArtifactHtml(first.html, {
    requiredDataBlocks: first.model.requiredDataBlocks,
  });
  const destination = revalidateOutputParent(outputPin, outputPath);
  assertDistinctPaths(manifestPath, destination);
  assertWritableDestination(destination, force);
  atomicWriteUtf8(destination, first.html, { overwrite: force });
  return {
    ok: true,
    contractVersion: 2,
    mode: "interactive",
    output: outputPath,
    title: first.model.metadata.title,
    bytes: Buffer.byteLength(first.html, "utf8"),
    sourceHash: verification.sourceHash,
    outputHash: sha256(first.html),
    dataBlockIds: verification.dataBlockIds,
    theme: themeIdentity,
  };
}
