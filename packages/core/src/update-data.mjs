import { createHash } from "node:crypto";
import { lstatSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

import { renderInteractiveArtifactWithData } from "./build-interactive.mjs";
import { detectArtifactContract } from "./contracts.mjs";
import {
  canonicalizeJson,
  DATA_BLOCK_ID,
  extractDataBlocks,
} from "./data-blocks.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { atomicWriteUtf8, readUtf8File } from "./io.mjs";
import { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";
import { verifyArtifactHtml } from "./verify.mjs";

const UPDATE_KEYS = new Set([
  "artifactPath",
  "manifestPath",
  "id",
  "value",
  "theme",
  "outputPath",
  "force",
  "verifyDeterminism",
  "upgradeContract",
]);

function fail(code, message, details = undefined, options = undefined) {
  throw new ArtifactBuildError(code, message, details, options);
}

function inspectOptions(options) {
  if (options === null || typeof options !== "object") {
    fail("INVALID_UPDATE_OPTIONS", "Update options must be a plain object");
  }
  let array;
  let descriptors;
  let keys;
  let prototype;
  try {
    array = Array.isArray(options);
    descriptors = Object.getOwnPropertyDescriptors(options);
    keys = Reflect.ownKeys(options);
    prototype = Object.getPrototypeOf(options);
  } catch (cause) {
    fail(
      "INVALID_UPDATE_OPTIONS",
      "Update options cannot be inspected safely",
      undefined,
      { cause },
    );
  }
  if (array || (prototype !== Object.prototype && prototype !== null)) {
    fail("INVALID_UPDATE_OPTIONS", "Update options must be a plain object");
  }
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !UPDATE_KEYS.has(key) ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      fail("INVALID_UPDATE_OPTIONS", "Update options contain an invalid property");
    }
    values[key] = descriptor.value;
  }
  return values;
}

function pathValue(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(
      "INVALID_UPDATE_OPTIONS",
      `${label} must be a non-empty local filesystem path`,
    );
  }
  return resolve(value);
}

function booleanValue(value, fallback, label) {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") {
    fail("INVALID_UPDATE_OPTIONS", `${label} must be a boolean`);
  }
  return value;
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
      "INVALID_UPDATE_OPTIONS",
      "Output parent must already resolve to a local directory",
      { output: outputPath },
      { cause },
    );
  }
  if (!stats.isDirectory()) {
    fail("INVALID_UPDATE_OPTIONS", "Output parent must resolve to a directory", {
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

function revalidateOutputParent(pin, outputPath) {
  let canonicalParent;
  let stats;
  try {
    canonicalParent = realpathSync(pin.requestedParent);
    stats = statSync(canonicalParent, { bigint: true });
  } catch (cause) {
    fail(
      "INVALID_UPDATE_OPTIONS",
      "Output parent changed while rebuilding",
      { output: outputPath },
      { cause },
    );
  }
  if (
    !stats.isDirectory() ||
    canonicalParent !== pin.canonicalParent ||
    stats.dev !== pin.identity.dev ||
    stats.ino !== pin.identity.ino
  ) {
    fail("INVALID_UPDATE_OPTIONS", "Output parent changed while rebuilding", {
      output: outputPath,
    });
  }
  return pin.destination;
}

function fileIdentity(path, label) {
  try {
    const lexical = lstatSync(path, { bigint: true });
    if (lexical.isSymbolicLink()) {
      fail("INVALID_UPDATE_OPTIONS", `${label} must not be a symbolic link`, {
        path,
      });
    }
    const canonical = realpathSync(path);
    const stats = statSync(canonical, { bigint: true });
    if (!stats.isFile()) {
      fail("INVALID_UPDATE_OPTIONS", `${label} must resolve to a regular file`, {
        path,
      });
    }
    return Object.freeze({ canonical, dev: stats.dev, ino: stats.ino });
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) throw cause;
    fail(
      "INVALID_UPDATE_OPTIONS",
      `Unable to inspect ${label}`,
      { path },
      { cause },
    );
  }
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function existingFileIdentity(path, label) {
  try {
    return fileIdentity(path, label);
  } catch (cause) {
    if (
      cause instanceof ArtifactBuildError &&
      cause.cause?.code === "ENOENT"
    ) {
      return undefined;
    }
    throw cause;
  }
}

function assertDestinationAvailable(destination, force, inPlace) {
  if (inPlace || force) return;
  try {
    lstatSync(destination);
  } catch (cause) {
    if (cause?.code === "ENOENT") return;
    fail(
      "ATOMIC_WRITE_FAILED",
      "Unable to inspect output destination",
      { output: destination },
      { cause },
    );
  }
  fail("OUTPUT_EXISTS", "Output already exists; pass force to replace it", {
    output: destination,
  });
}

function canonicalReplacement(value) {
  const nodeBudget = {
    maximum: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
    remaining: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
  };
  try {
    return canonicalizeJson(value, { nodeBudget });
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) throw cause;
    fail("INVALID_DATA_BLOCK", "Replacement data cannot be inspected safely");
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function unchangedSource(sourcePath, sourceBefore, identityBefore) {
  const identityAfter = fileIdentity(sourcePath, "artifactPath");
  const sourceAfter = readUtf8File(sourcePath);
  if (
    identityAfter.canonical !== identityBefore.canonical ||
    !sameIdentity(identityAfter, identityBefore) ||
    !sourceAfter.bytes.equals(sourceBefore.bytes)
  ) {
    fail("ARTIFACT_CHANGED", "Artifact changed while rebuilding", {
      artifact: sourcePath,
    });
  }
}

export async function updateArtifactData(options) {
  const inspected = inspectOptions(options);
  const sourcePath = pathValue(inspected.artifactPath, "artifactPath");
  const sourceIdentity = fileIdentity(sourcePath, "artifactPath");
  const source = readUtf8File(sourcePath);
  const contract = detectArtifactContract(source.content);

  if (contract.version === 1 && inspected.upgradeContract !== 2) {
    fail(
      "CONTRACT_UPGRADE_REQUIRED",
      "Contract-v1 artifacts require explicit upgradeContract: 2",
      { oldContract: 1, requiredContract: 2 },
    );
  }

  const sourceVerification = verifyArtifactHtml(source.content);
  if (contract.mode !== "interactive" || sourceVerification.mode !== "interactive") {
    fail("INVALID_ARTIFACT_MODE", "Only interactive artifacts support data updates");
  }
  if (
    inspected.upgradeContract !== undefined &&
    inspected.upgradeContract !== 2
  ) {
    fail("INVALID_UPDATE_OPTIONS", "upgradeContract only accepts 2");
  }
  if (typeof inspected.id !== "string" || !DATA_BLOCK_ID.test(inspected.id)) {
    fail("INVALID_DATA_BLOCK", "Data block id must match DATA_BLOCK_ID");
  }
  const replacement = canonicalReplacement(inspected.value);
  const manifestPath = pathValue(inspected.manifestPath, "manifestPath");
  const requestedOutput =
    inspected.outputPath === undefined
      ? sourcePath
      : pathValue(inspected.outputPath, "outputPath");
  const verifyDeterminism = booleanValue(
    inspected.verifyDeterminism,
    true,
    "verifyDeterminism",
  );
  const inPlace = requestedOutput === sourcePath;
  const force = booleanValue(inspected.force, inPlace, "force");
  const outputPin = pinOutputParent(requestedOutput);
  const destination = outputPin.destination;

  if (!inPlace) {
    const destinationIdentity = existingFileIdentity(destination, "outputPath");
    if (
      destinationIdentity !== undefined &&
      sameIdentity(destinationIdentity, sourceIdentity)
    ) {
      fail(
        "INVALID_UPDATE_OPTIONS",
        "artifactPath and outputPath must not alias",
      );
    }
  }
  assertDestinationAvailable(destination, force, inPlace);

  const blocks = extractDataBlocks(source.content);
  if (!blocks.has(inspected.id)) {
    fail("MISSING_DATA_BLOCK", "Artifact does not contain the requested data block", {
      id: inspected.id,
    });
  }
  blocks.set(inspected.id, replacement);

  const rendered = await renderInteractiveArtifactWithData({
    manifestPath,
    theme: inspected.theme,
    preservedData: blocks,
    verifyDeterminism,
  });
  if (
    rendered.verification.dataBlockIds.length !== blocks.size ||
    rendered.verification.dataBlockIds.some((id) => !blocks.has(id))
  ) {
    fail("DATA_BLOCK_SET_CHANGED", "Rebuild changed the verified data block set");
  }

  unchangedSource(sourcePath, source, sourceIdentity);
  const revalidatedDestination = revalidateOutputParent(outputPin, requestedOutput);
  if (revalidatedDestination !== destination) {
    fail("INVALID_UPDATE_OPTIONS", "Output destination changed while rebuilding");
  }
  if (!inPlace) {
    const destinationIdentity = existingFileIdentity(destination, "outputPath");
    if (
      destinationIdentity !== undefined &&
      sameIdentity(destinationIdentity, sourceIdentity)
    ) {
      fail(
        "INVALID_UPDATE_OPTIONS",
        "artifactPath and outputPath must not alias",
      );
    }
  }
  assertDestinationAvailable(destination, force, inPlace);
  atomicWriteUtf8(destination, rendered.html, { overwrite: force || inPlace });

  return {
    ok: true,
    oldContract: contract.version,
    newContract: 2,
    theme: rendered.themeIdentity,
    sourceHash: rendered.verification.sourceHash,
    outputHash: sha256(rendered.html),
    preservedBlockIds: rendered.verification.dataBlockIds.filter(
      (id) => id !== inspected.id,
    ),
    outputPath: requestedOutput,
  };
}
