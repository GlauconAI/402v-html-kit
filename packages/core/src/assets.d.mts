import type { ArtifactEntry, ArtifactSvgEntry } from "./contracts.mjs";

export declare function resolveTrustedEntry(
  rootDirectory: unknown,
  source: unknown,
  internalOptions?: unknown,
): { label: string };
export declare function loadScriptEntry(
  rootDirectory: unknown,
  source: unknown,
  internalOptions?: unknown,
): ArtifactEntry;
export declare function loadStylesheetEntry(
  rootDirectory: unknown,
  source: unknown,
  internalOptions?: unknown,
): ArtifactEntry;
export declare function validateInlineStylesheet(content: unknown): string;
export declare function validateInlineSvgStyle(content: unknown): string;
export declare function loadSvgAsset(
  rootDirectory: unknown,
  definition: unknown,
  internalOptions?: unknown,
): ArtifactSvgEntry;
