export interface AtomicInstallOperations {
  link(source: string, target: string): void;
  unlink(path: string): void;
}

export declare function installNoClobber(
  temporaryPath: string,
  destination: string,
  operations?: AtomicInstallOperations,
): void;
