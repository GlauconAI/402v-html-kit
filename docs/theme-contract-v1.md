# Theme Contract v1

Themes are installed or explicit local build-time modules. The CLI resolves a
specifier, imports the module, and passes its object to core. Programmatic core
callers import and pass the object themselves.

The public declarations are:

```ts
interface ArtifactThemeV1 {
  themeContractVersion: 1;
  id: string;
  version: string;
  displayName: string;
  render(input: ThemeRenderInput): ThemeRenderResult;
}

interface ThemeRenderInput {
  readonly mode: "note" | "interactive";
  readonly metadata: Readonly<ArtifactMetadata>;
  readonly content: {
    readonly articleHtml?: string;
    readonly headings?: readonly Heading[];
    readonly slots?: Readonly<ArtifactSlots>;
    readonly svg?: Readonly<Record<string, PreparedSvg>>;
  };
}

interface ThemeRenderResult {
  readonly lang: string;
  readonly styles: string;
  readonly bodyHtml: string;
}
```

Theme IDs are bounded neutral identifiers; versions are SemVer strings;
`displayName` is bounded display text. Core copies and deeply freezes the
render input. The content is already parsed/prepared: note themes receive
`articleHtml` and headings, while interactive themes receive renderer slots and
prepared SVG entries.

The result must be a plain data object with exactly `lang`, `styles`, and
`bodyHtml`. The language must match artifact metadata. The stylesheet cannot
load external resources. Body HTML cannot own the doctype, document elements,
metadata, links, styles, scripts, JSON blocks, protocol attributes, or event
handlers; it cannot contain active resources or unsafe navigation.

Core alone owns metadata, data blocks, source hashing, the neutral root,
runtime, consumer scripts, verification, resource limits, and document order. A
theme cannot waive a verifier issue or change those limits.

## Trust warning

The contract constrains returned output, not module execution. Themes are
trusted local build-time code and are not sandboxed. Import and `render()` run
with the build process's Node.js authority. Review installed packages and local
dependency graphs; remote theme URLs and automatic installation are unsupported.

## Minimal module

```js
export default Object.freeze({
  themeContractVersion: 1,
  id: "paper",
  version: "1.0.0",
  displayName: "Paper",
  render(input) {
    return Object.freeze({
      lang: input.metadata.lang,
      styles: ".paper{max-width:70ch;margin:auto}",
      bodyHtml: `<main class="paper">${input.content.articleHtml ?? ""}</main>`,
    });
  },
});
```

Run the checked-in version with the commands in the
[custom-theme quick start](../README.md#custom-theme-quick-start).
