export interface ReadUtf8Result {
  bytes: Buffer;
  byteLength: number;
  content: string;
  path: string;
}

export declare function readUtf8File(
  pathInput: unknown,
  options?: unknown,
): ReadUtf8Result;
export declare function atomicWriteUtf8(
  pathInput: unknown,
  content: unknown,
  options?: unknown,
): void;
