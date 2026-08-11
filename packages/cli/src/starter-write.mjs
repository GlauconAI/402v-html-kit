import {
  closeSync,
  lstatSync,
  linkSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { ArtifactBuildError } from "@402v/html-kit-core";

const DEFAULT_OPERATIONS = Object.freeze({
  close: closeSync,
  link: linkSync,
  lstat: lstatSync,
  open: openSync,
  realpath: realpathSync,
  rename: renameSync,
  unlink: unlinkSync,
  write: writeFileSync,
});

function fail(code, message) {
  throw new ArtifactBuildError(code, message);
}

function contained(root, candidate) {
  const difference = relative(root, candidate);
  return difference === "" ||
    (!isAbsolute(difference) && difference !== ".." && !difference.startsWith(`..${sep}`));
}

export function atomicContainedWrite(
  directory,
  name,
  content,
  force,
  operationOverrides = undefined,
) {
  const operations = operationOverrides === undefined
    ? DEFAULT_OPERATIONS
    : { ...DEFAULT_OPERATIONS, ...operationOverrides };
  const canonical = operations.realpath(directory);
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
    descriptor = operations.open(temporary, "wx", 0o600);
    operations.write(descriptor, content, "utf8");
    operations.close(descriptor);
    descriptor = undefined;
    if (
      operations.realpath(directory) !== canonical ||
      operations.lstat(canonical).isSymbolicLink()
    ) {
      fail("ATOMIC_WRITE_FAILED", "Starter directory changed during write");
    }
    if (force) {
      operations.rename(temporary, destination);
    } else {
      operations.link(temporary, destination);
      operations.unlink(temporary);
    }
  } catch (error) {
    if (descriptor !== undefined) {
      try { operations.close(descriptor); } catch {}
    }
    try { operations.unlink(temporary); } catch {}
    if (error instanceof ArtifactBuildError) throw error;
    if (!force && error?.code === "EEXIST") {
      fail("OUTPUT_EXISTS", "Starter output appeared during installation");
    }
    fail("ATOMIC_WRITE_FAILED", "Starter file could not be installed atomically");
  }
}
