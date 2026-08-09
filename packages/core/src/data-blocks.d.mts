export declare const DATA_BLOCK_ID: RegExp;
export declare function canonicalizeJson(
  value: unknown,
  options?: unknown,
): unknown;
export declare function stableJson(value: unknown): string;
export declare function serializeDataBlocks(blocks: unknown): string;
export declare function extractDataBlocks(html: unknown): Map<string, unknown>;
export declare function computeSourceHash(blocks: unknown): string;
