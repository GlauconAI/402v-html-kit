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
export { renderThemeV1 } from "./theme-contract.mjs";
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

export interface BuildNoteOptions {
  inputPath: string;
  outputPath: string;
  force?: boolean;
  theme: import("./theme-contract.mjs").ArtifactThemeV1;
}

export interface NoteBuildResult {
  ok: true;
  contractVersion: 2;
  mode: "note";
  output: string;
  title: string;
  bytes: number;
  sourceHash: string;
  outputHash: string;
  dataBlockIds: string[];
  theme: Readonly<ArtifactV2ThemeIdentity>;
}

export declare function buildNote(
  options: BuildNoteOptions,
): Promise<NoteBuildResult>;

export interface BuildInteractiveArtifactOptions {
  manifestPath: string;
  outputPath: string;
  force?: boolean;
  theme: import("./theme-contract.mjs").ArtifactThemeV1;
  verifyDeterminism?: boolean;
}

export interface InteractiveBuildResult {
  ok: true;
  contractVersion: 2;
  mode: "interactive";
  output: string;
  title: string;
  bytes: number;
  sourceHash: string;
  outputHash: string;
  dataBlockIds: string[];
  theme: Readonly<ArtifactV2ThemeIdentity>;
}

export declare function buildInteractiveArtifact(
  options: BuildInteractiveArtifactOptions,
): Promise<InteractiveBuildResult>;

export type {
  ArtifactContract,
  ArtifactVerificationResult,
  VerifyArtifactHtmlOptions,
} from "./contracts.mjs";

export type {
  ArtifactThemeV1,
  Heading,
  PreparedSvg,
  ThemeRenderInput,
  ThemeRenderResult,
} from "./theme-contract.mjs";

import type {
  ArtifactVerificationResult,
  VerifyArtifactHtmlOptions,
} from "./contracts.mjs";

export declare function verifyArtifactHtml(
  html: string,
  options?: VerifyArtifactHtmlOptions,
): ArtifactVerificationResult;

export interface VerifyArtifactOptions extends VerifyArtifactHtmlOptions {
  path: string;
}

export declare function verifyArtifact(
  options: VerifyArtifactOptions,
): ArtifactVerificationResult;
