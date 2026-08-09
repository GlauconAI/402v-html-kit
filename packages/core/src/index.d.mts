export { ArtifactBuildError } from "./errors.mjs";
export {
  canonicalizeJson,
  computeSourceHash,
  extractDataBlocks,
  serializeDataBlocks,
  stableJson,
} from "./data-blocks.mjs";
export { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";
export { detectArtifactContract } from "./contracts.mjs";
export interface ArtifactV2ThemeIdentity {
  id: string;
  version: string;
}

export interface ArtifactV2ThemeOutput {
  lang: string;
  styles: string;
  bodyHtml: string;
}

export interface AssembleArtifactV2Input {
  mode: "note" | "interactive";
  metadata: import("./contracts.mjs").ArtifactMetadata;
  theme: ArtifactV2ThemeIdentity;
  themeOutput: ArtifactV2ThemeOutput;
  dataBlocks: Map<string, unknown>;
  consumerScripts: string[];
}

export declare function assembleArtifactV2(input: AssembleArtifactV2Input): string;

export type {
  ArtifactContract,
  ArtifactVerificationResult,
  VerifyArtifactHtmlOptions,
} from "./contracts.mjs";

import type {
  ArtifactVerificationResult,
  VerifyArtifactHtmlOptions,
} from "./contracts.mjs";

export declare function verifyArtifactHtml(
  html: string,
  options?: VerifyArtifactHtmlOptions,
): ArtifactVerificationResult;
