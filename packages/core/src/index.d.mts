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
