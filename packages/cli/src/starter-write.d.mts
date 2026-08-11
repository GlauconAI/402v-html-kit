import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";

export interface StarterWriteOperations {
  close: typeof closeSync;
  link: typeof linkSync;
  lstat: typeof lstatSync;
  open: typeof openSync;
  realpath: typeof realpathSync;
  rename: typeof renameSync;
  unlink: typeof unlinkSync;
  write: typeof writeFileSync;
}

export declare function atomicContainedWrite(
  directory: string,
  name: string,
  content: string,
  force: boolean,
  operationOverrides?: Partial<StarterWriteOperations>,
): void;
