export interface ArtifactMetadata {
  title: string;
  description: string;
  eyebrow: string;
  lang: string;
}

export interface ArtifactEntry {
  label: string;
  content: string;
  byteLength?: number;
}

export interface ArtifactSvgEntry {
  id: string;
  label: string;
  html: string;
  byteLength?: number;
}

export interface ArtifactSlots {
  navigation?: string;
  heroSupplementary?: string;
  mainSections?: string;
  rail?: string;
  footer?: string;
}

export interface InteractiveModel {
  metadata: ArtifactMetadata;
  data: Map<string, unknown>;
  slots: ArtifactSlots;
  styles: ArtifactEntry[];
  scripts: ArtifactEntry[];
  svg: ArtifactSvgEntry[];
  requiredDataBlocks: string[];
}

export interface ArtifactManifest {
  contractVersion: 1;
  mode: "interactive";
  rootDirectory: string;
  metadata: ArtifactMetadata;
  dataBlocks: Array<{ id: string; source: string }>;
  renderer: string;
  styles: string[];
  scripts: string[];
  svgAssets: Array<{
    id: string;
    source: string;
    title?: string;
    description?: string;
  }>;
  requiredDataBlocks: string[];
}

export interface ArtifactContract {
  version: 1 | 2;
  mode: "note" | "interactive";
}

export interface VerifyArtifactHtmlOptions {
  requiredDataBlocks?: string[];
  startupTimeoutMs?: number;
}

export interface VerificationIssue {
  code: string;
  message: string;
  details?: unknown;
}

export interface ArtifactVerificationResult {
  ok: true;
  contractVersion: 1 | 2;
  mode: "interactive" | "note";
  sourceHash: string | undefined;
  dataBlockIds: string[];
  issues: VerificationIssue[];
}

export interface ArtifactStartupResult {
  ok: true;
  issues: VerificationIssue[];
}

export interface InteractiveBuildResult {
  ok: true;
  mode: "interactive";
  output: string;
  title: string;
  bytes: number;
  sourceHash: string;
  outputHash: string;
  dataBlockIds: string[];
}

export interface NoteBuildResult {
  ok: true;
  mode: "note";
  output: string;
  title: string;
  bytes: number;
  outputHash: string;
  dataBlockIds: string[];
}

export declare function detectArtifactContract(html: string): ArtifactContract;
