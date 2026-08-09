# Contract v1 compatibility provenance

The frozen contract-v1 fixtures and copied primitives in this repository come
from the canonical `glaucon-politeia` source:

- repository: <https://github.com/GlauconAI/glaucon-politeia>
- source commit: `9527b4fd8c3ff3c49180516440f715a6d1798c8f` (`9527b4f`)
- commit permalink: <https://github.com/GlauconAI/glaucon-politeia/commit/9527b4fd8c3ff3c49180516440f715a6d1798c8f>

The copied `assets.d.mts` declaration has a type-only import from
`contracts.mjs`. Therefore `packages/core/src/contracts.d.mts` is also copied
byte-for-byte from the same baseline as a declaration-only prerequisite. Task
3 will pair it with the corresponding runtime `contracts.mjs`; Task 2 does not
export this declaration from the temporary core entry point.

The standalone workspace disables `checkJs` while retaining `strict` type
checking. The contract-v1 JavaScript must remain byte-frozen, and the reviewed
source has no declaration for every internal JavaScript primitive. Typecheck
therefore validates the copied `.d.mts` public declarations and TypeScript
tests without rewriting or suppressing errors inside the frozen JavaScript.

The recorded fixtures were generated and byte-parity verified with Node.js
`v25.9.0` and npm `11.12.1`. These versions record the verified regeneration
environment; they do not claim broader runtime compatibility.

For a fresh portable regeneration, clone the canonical repository, detach at
the reviewed commit, and install exactly from its committed lockfile before
running the unchanged CLI:

```sh
git clone https://github.com/GlauconAI/glaucon-politeia.git
cd glaucon-politeia
git checkout --detach 9527b4fd8c3ff3c49180516440f715a6d1798c8f
npm ci
mkdir -p .generated
node scripts/html-note-kit.mjs init .generated/note --title "Contract v1 Compatibility Note"
node scripts/html-note-kit.mjs build .generated/note/note.md --output .generated/note.html
node scripts/html-note-kit.mjs build-artifact fixtures/html-note-kit-interactive/artifact.mjs --output .generated/interactive.html
```

`tests/compatibility/fixtures/v1/note.html` is the byte-for-byte copy of
`.generated/note.html`. Its source input is `.generated/note/note.md`, created
by the preceding `init` command at the same commit.

`tests/compatibility/fixtures/v1/interactive.html` is the byte-for-byte copy of
`.generated/interactive.html`. Its manifest is
`fixtures/html-note-kit-interactive/artifact.mjs`, which references these
commit-local inputs:

- `fixtures/html-note-kit-interactive/data/projects.json`
- `fixtures/html-note-kit-interactive/renderer.mjs`
- `fixtures/html-note-kit-interactive/artifact.css`
- `fixtures/html-note-kit-interactive/artifact.js`
- `fixtures/html-note-kit-interactive/system-map.svg`

The generated interactive fixture inherits trailing whitespace on lines 608,
615, and 668. Those bytes are part of the frozen source output and are not
normalized. The fixture-scoped `.gitattributes` rule disables Git whitespace
diagnostics only for these frozen HTML files so `git diff --check` can validate
all authored and copied source without mutating compatibility bytes.

## Frozen SHA-256 checksums

```text
56763f265a8616c3a305727adcf6a8fd901ccf77e4d214aebf5b11d47bff51a0  tests/compatibility/fixtures/v1/interactive.html
d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056  tests/compatibility/fixtures/v1/note.html
```
