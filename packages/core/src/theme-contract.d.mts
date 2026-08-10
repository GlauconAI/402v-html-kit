import type { ArtifactMetadata, ArtifactSlots } from "./contracts.mjs";

export interface Heading {
  id: string;
  level: number;
  text: string;
}

export interface PreparedSvg {
  id: string;
  label: string;
  html: string;
  byteLength?: number;
}

export interface ThemeRenderInput {
  mode: "note" | "interactive";
  metadata: ArtifactMetadata;
  content: {
    articleHtml?: string;
    headings?: Heading[];
    slots?: ArtifactSlots;
    svg?: Record<string, PreparedSvg>;
  };
}

export interface ThemeRenderResult {
  lang: string;
  styles: string;
  bodyHtml: string;
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
