import { ArtifactBuildError } from "./errors.mjs";

/**
 * @param {string[]} contents
 * @param {{ maximumBytes?: number } | undefined} [options]
 * @returns {number}
 */
export function sumUtf8TextBytes(contents, options = undefined) {
  if (!Array.isArray(contents) || contents.some((content) => typeof content !== "string")) {
    throw new ArtifactBuildError(
      "INVALID_DATA_BLOCK",
      "Data block text accounting requires an array of strings",
    );
  }
  const maximumBytes = options?.maximumBytes ?? Number.MAX_SAFE_INTEGER;
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    throw new ArtifactBuildError(
      "INVALID_DATA_BLOCK",
      "Data block text accounting requires a non-negative byte limit",
    );
  }
  let bytes = 0;
  for (const content of contents) {
    bytes += Buffer.byteLength(content, "utf8");
    if (bytes > maximumBytes) {
      throw new ArtifactBuildError(
        "RESOURCE_LIMIT_EXCEEDED",
        "Artifact data blocks exceed the JSON text byte limit",
        { maximumBytes },
      );
    }
  }
  return bytes;
}
