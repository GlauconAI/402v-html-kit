import { linkSync, unlinkSync } from "node:fs";

import { ArtifactBuildError } from "./errors.mjs";

const CLEANUP_ATTEMPTS = 3;
const DEFAULT_OPERATIONS = Object.freeze({
  link: linkSync,
  unlink: unlinkSync,
});

function boundedUnlink(path, unlink) {
  let lastCause;
  for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt += 1) {
    try {
      unlink(path);
      return undefined;
    } catch (cause) {
      if (cause?.code === "ENOENT") return undefined;
      lastCause = cause;
    }
  }
  return lastCause;
}

export function installNoClobber(
  temporaryPath,
  destination,
  operations = DEFAULT_OPERATIONS,
) {
  operations.link(temporaryPath, destination);
  try {
    operations.unlink(temporaryPath);
    return;
  } catch (cause) {
    const rollbackCause = boundedUnlink(destination, operations.unlink);
    const cleanupCause = boundedUnlink(temporaryPath, operations.unlink);
    throw new ArtifactBuildError(
      "ATOMIC_WRITE_FAILED",
      "Unable to finalize a no-clobber atomic write",
      {
        cleanupComplete: cleanupCause === undefined,
        rollbackComplete: rollbackCause === undefined,
      },
      { cause },
    );
  }
}
