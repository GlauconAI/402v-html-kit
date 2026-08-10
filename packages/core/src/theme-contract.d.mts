import type { ArtifactMetadata, ArtifactSlots } from "./contracts.mjs";

export interface Heading {
  readonly id: string;
  readonly level: number;
  readonly text: string;
}

export interface PreparedSvg {
  readonly id: string;
  readonly label: string;
  readonly html: string;
  readonly byteLength?: number;
}

export interface ThemeRenderInput {
  readonly mode: "note" | "interactive";
  readonly metadata: Readonly<ArtifactMetadata>;
  readonly content: {
    readonly articleHtml?: string;
    readonly headings?: readonly Heading[];
    readonly slots?: Readonly<ArtifactSlots>;
    readonly svg?: Readonly<Record<string, PreparedSvg>>;
  };
}

export interface ThemeRenderResult {
  readonly lang: string;
  readonly styles: string;
  readonly bodyHtml: string;
}

export interface ArtifactThemeV1 {
  themeContractVersion: 1;
  id: string;
  version: string;
  displayName: string;
  render(input: ThemeRenderInput): ThemeRenderResult;
}

export declare function renderThemeV1(
  theme: ArtifactThemeV1,
  input: ThemeRenderInput,
): ThemeRenderResult;
