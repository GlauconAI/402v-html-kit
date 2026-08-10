import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
} from "node:fs";
import { resolve } from "node:path";

import { ArtifactBuildError, ARTIFACT_RESOURCE_LIMITS } from "@402v/html-kit-core";

const READ_CHUNK_BYTES = 64 * 1024;
const DEFAULT_OPERATIONS = Object.freeze({
  close: closeSync,
  constants,
  fstat: fstatSync,
  lstat: lstatSync,
  open: openSync,
  read: readSync,
  realpath: realpathSync,
});

function fail(code, message) {
  throw new ArtifactBuildError(code, message);
}

function boundedPath(value, code, label) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    fail(code, `${label} path must be a bounded non-empty local path`);
  }
  return resolve(value);
}

export function readBoundedUtf8(
  input,
  {
    maximumBytes,
    code = "ARTIFACT_READ_FAILED",
    label = "File",
    operations = DEFAULT_OPERATIONS,
  },
) {
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 0) {
    fail(code, `${label} byte limit is invalid`);
  }
  const requested = boundedPath(input, code, label);
  let descriptor;
  try {
    const lexical = operations.lstat(requested, { bigint: true });
    if (lexical.isSymbolicLink() || !lexical.isFile()) {
      fail(code, `${label} must be one regular non-symbolic-link file`);
    }
    const canonical = operations.realpath(requested);
    descriptor = operations.open(
      requested,
      operations.constants.O_RDONLY | (operations.constants.O_NOFOLLOW ?? 0),
    );
    const before = operations.fstat(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== lexical.dev ||
      before.ino !== lexical.ino ||
      before.size > BigInt(maximumBytes) ||
      operations.realpath(requested) !== canonical
    ) {
      fail(code, `${label} changed before it could be read safely`);
    }

    const chunks = [];
    let length = 0;
    while (length <= maximumBytes) {
      const remaining = maximumBytes + 1 - length;
      if (remaining === 0) break;
      const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, remaining));
      const count = operations.read(
        descriptor,
        chunk,
        0,
        chunk.length,
        null,
      );
      if (count === 0) break;
      chunks.push(chunk.subarray(0, count));
      length += count;
    }
    if (length > maximumBytes) {
      fail(code, `${label} exceeds its byte limit`);
    }

    const after = operations.fstat(descriptor, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs ||
      operations.realpath(requested) !== canonical
    ) {
      fail(code, `${label} changed while being read`);
    }

    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks, length),
      );
    } catch {
      fail(code, `${label} must contain strict UTF-8`);
    }
  } catch (error) {
    if (error instanceof ArtifactBuildError) throw error;
    fail(code, `${label} could not be read safely`);
  } finally {
    if (descriptor !== undefined) {
      try {
        operations.close(descriptor);
      } catch {
        // Preserve the stable primary result or failure.
      }
    }
  }
}

/**
 * Private CLI helper. The operations override exists only for bounded race
 * tests and is deliberately not part of the package export surface.
 * @param {string} input
 * @param {any} [options]
 */
export function readJsonValue(input, options = undefined) {
  const content = readBoundedUtf8(input, {
    maximumBytes: options?.maximumBytes ?? ARTIFACT_RESOURCE_LIMITS.rawJsonBytes,
    code: "INVALID_DATA_BLOCK",
    label: "JSON input",
    ...(options?.operations === undefined
      ? {}
      : { operations: options.operations }),
  });
  try {
    return JSON.parse(content);
  } catch {
    fail("INVALID_DATA_BLOCK", "JSON input must contain one valid JSON value");
  }
}
