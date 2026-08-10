import { detectArtifactContract } from "./contracts.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { readUtf8File } from "./io.mjs";
import { failVerification, issue } from "./verify-common.mjs";
import { verifyArtifactV1Html } from "./verify-v1.mjs";
import { verifyArtifactV2Html } from "./verify-v2.mjs";

const VERIFY_FILE_KEYS = new Set([
  "path",
  "requiredDataBlocks",
  "startupTimeoutMs",
]);

function invalidVerificationOptions(message) {
  throw new ArtifactBuildError(
    "ARTIFACT_VERIFICATION_FAILED",
    "Artifact verification received invalid options",
    { issues: [{ code: "INVALID_VERIFICATION_OPTIONS", message }] },
  );
}

function inspectVerifyFileOptions(options) {
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    invalidVerificationOptions("Verification options must be a plain object");
  }
  let descriptors;
  let keys;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(options);
    keys = Reflect.ownKeys(options);
    prototype = Object.getPrototypeOf(options);
  } catch {
    invalidVerificationOptions("Verification options cannot be inspected safely");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    invalidVerificationOptions("Verification options must be a plain object");
  }
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !VERIFY_FILE_KEYS.has(key) ||
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value")
    ) {
      invalidVerificationOptions("Verification options contain an invalid property");
    }
    values[key] = descriptor.value;
  }
  if (typeof values.path !== "string" || values.path.length === 0) {
    invalidVerificationOptions("Verification requires one non-empty path");
  }
  return values;
}

export function verifyArtifactHtml(html, options = undefined) {
  if (typeof html !== "string") {
    failVerification([issue("INVALID_HTML_INPUT", "Artifact HTML must be a string")]);
  }
  const contract = detectArtifactContract(html);
  if (contract.version === 1) return verifyArtifactV1Html(html, options);
  if (contract.version === 2) return verifyArtifactV2Html(html, options);
  throw new ArtifactBuildError(
    "UNSUPPORTED_ARTIFACT_CONTRACT",
    "Artifact verification is not implemented for this contract version",
    { version: contract.version },
  );
}

export function verifyArtifactFile(path, options = undefined) {
  let loaded;
  try {
    loaded = readUtf8File(path);
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) {
      failVerification([
        issue(
          cause.message.includes("valid UTF-8") ? "INVALID_UTF8" : "ARTIFACT_READ_FAILED",
          cause.message.includes("valid UTF-8")
            ? "Artifact file must contain strict UTF-8"
            : "Artifact file could not be read safely",
        ),
      ]);
    }
    throw cause;
  }
  return verifyArtifactHtml(loaded.content, options);
}

export function verifyArtifact(options) {
  const inspected = inspectVerifyFileOptions(options);
  return verifyArtifactFile(inspected.path, {
    requiredDataBlocks: inspected.requiredDataBlocks,
    startupTimeoutMs: inspected.startupTimeoutMs,
  });
}
