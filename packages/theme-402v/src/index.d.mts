interface Theme402vMetadata {
  readonly title: string;
  readonly description: string;
  readonly eyebrow: string;
  readonly lang: string;
}

interface Theme402vHeading {
  readonly id: string;
  readonly level: number;
  readonly text: string;
}

interface Theme402vSlots {
  readonly navigation?: string;
  readonly heroSupplementary?: string;
  readonly mainSections?: string;
  readonly rail?: string;
  readonly footer?: string;
}

interface Theme402vPreparedSvg {
  readonly id: string;
  readonly label: string;
  readonly html: string;
  readonly byteLength?: number;
}

interface Theme402vRenderInput {
  readonly mode: "note" | "interactive";
  readonly metadata: Theme402vMetadata;
  readonly content: {
    readonly articleHtml?: string;
    readonly headings?: readonly Theme402vHeading[];
    readonly slots?: Theme402vSlots;
    readonly svg?: Readonly<Record<string, Theme402vPreparedSvg>>;
  };
}

interface Theme402vRenderResult {
  readonly lang: string;
  readonly styles: string;
  readonly bodyHtml: string;
}

interface Theme402v {
  readonly themeContractVersion: 1;
  readonly id: "402v";
  readonly version: "0.1.0";
  readonly displayName: "402v";
  readonly render: (input: Theme402vRenderInput) => Readonly<Theme402vRenderResult>;
}

export declare const theme402v: Readonly<Theme402v>;
export default theme402v;
