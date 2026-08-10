# 402v HTML Workflow Skill impact matrix

Status: **proposal input only**. This document records the delta from the
currently live `402v-html-workflow` Skill to the OSS v1 release candidate. It
does not change or apply a Skill and does not authorize a package, site, or
repository release.

## Evidence scope

The RC side of the comparison is derived from these checked-in authorities:

- `README.md`: package/runtime quick starts, CLI contract, theme selection,
  compatibility warning, and project boundary.
- `docs/architecture.md`: ownership boundaries and exact public core API.
- `docs/artifact-contract-v2.md`: neutral identifiers, modes, runtime, and
  verification result.
- `docs/theme-contract-v1.md`: theme object contract and trust boundary.
- `docs/migration-from-internal-v1.md`: read compatibility, explicit upgrade,
  unavailable preservation command, and v1-note limitation.
- `docs/security-model.md`: trusted inputs and stable error families.
- `docs/release-checklist.md`: recorded local acceptance evidence and external
  gates.
- `packages/*/package.json`: package names, exports, executable, engines, and
  dependencies.

The old side was checked read-only against the live `402v-html-workflow`
`SKILL.md`, `references/interactive.md`, and `references/publishing.md`.

## RED baseline

The current live Skill fails the five representative OSS v1 scenarios:

| Scenario | RED baseline result |
| --- | --- |
| Default note | Uses the internal `glaucon-politeia` checkout and `npm ... run html:note`; it does not select the published CLI, supported Node/npm runtime, or official default theme. |
| Default interactive | Teaches manifest `contractVersion: 1`, legacy `window.__402vArtifact`, and the internal wrapper instead of contract v2 and `window.__htmlKitArtifact`. |
| Custom/programmatic theme | Has no `--theme` workflow, requires a fixed 402v shell, and imports the old internal library path; it does not teach Theme Contract v1 objects or core's no-resolution boundary. |
| v1 verify versus upgrade | Does not distinguish read-only v1 verify/extract from explicit interactive `update-data --upgrade-contract 2`; it incorrectly presents `--preserve-data-from` as operational and has no v1-note rebuild-only rule. |
| Publication boundary | Sends the workflow directly to the legacy site publisher reference; it does not end OSS work at verified local HTML or route an explicitly authorized publication exclusively through `402v-html-publisher`. |

## Impact matrix

| Workflow surface | Old live Skill behavior | OSS v1 RC behavior | Required Skill proposal change | Evidence |
| --- | --- | --- | --- | --- |
| Package install/runtime and local pre-publication checkout | Treats `/projects/glaucon-politeia` as the permanent canonical runtime and invokes its npm scripts. | Runtime packages are `@402v/html-kit-cli`, `@402v/html-kit-core`, and `@402v/theme-402v`; supported runtime is Node `^22.13.0 \|\| >=24.0.0` and npm 10+. Before npm publication, only a locked local RC checkout is usable: run `npm ci`, then `npm exec -- 402v-html-kit ...`. | Teach installed-package use after the npm gate; label checkout + `npm ci` as the temporary local pre-publication path, not the durable API. Programmatic consumers declare/import core and a theme package directly. | `README.md` intro, runtime, and quick starts; all `packages/*/package.json` names/engines/dependencies. |
| CLI executable/name | Uses `npm --prefix ... run html:note -- ...`. | The CLI package exposes the `402v-html-kit` executable and commands `init`, `build`, `build-artifact`, `update-data`, and `verify`. | Replace every internal wrapper command with `npm exec -- 402v-html-kit ...` (or the installed executable). | `README.md` CLI reference; `packages/cli/package.json` `bin`. |
| Note versus interactive selection | Correctly distinguishes Markdown notes from manifest/data-driven interactive artifacts, but ties both to the old wrapper and one fixed presentation contract. | `build <input.md>` is note mode; `build-artifact <manifest.mjs>` is interactive mode. Note has no runtime/consumer script; interactive has canonical JSON blocks, runtime, and declared consumers. | Preserve the intent-based selection rule while replacing commands and contract details; do not force manifests/JSON onto notes. | `README.md` note/interactive quick starts; `docs/artifact-contract-v2.md` “Modes and runtime”; live `SKILL.md` “Select the mode”. |
| Official default theme | Mandates the old built-in 402v shell but does not identify a package-level default. | The CLI's official default for both modes is `@402v/theme-402v`, versioned separately from neutral core. | Name `@402v/theme-402v` as the default instead of hard-coding shell classes/layout as a core contract. | `README.md` intro and note quick start; `docs/architecture.md`; `packages/cli/package.json` dependency. |
| Theme precedence | No precedence rule. | Theme selection is explicit `--theme` **>** manifest `theme` **>** official default `@402v/theme-402v`. | Add the exact precedence and apply it to interactive builds and upgrades; note builds use flag or default. | `README.md` interactive quick start; `docs/migration-from-internal-v1.md` explicit interactive upgrade. |
| Custom theme CLI usage | No supported custom-theme path; shared contract tells agents not to substitute the fixed 402v visual. | A reviewed installed or local module can be selected, e.g. `402v-html-kit build input.md --theme ./artifact-theme.mjs ...`; remote theme URLs and automatic installation are unsupported. | Add `--theme <specifier>` examples and require review of the trusted local dependency graph. Remove fixed visual details from the neutral Kit contract. | `README.md` custom-theme quick start; `docs/theme-contract-v1.md` trust warning. |
| Programmatic callers and Theme Contract v1 | Imports builders from an absolute internal `lib/html-note-kit/index.mjs` path and passes no theme. | Import builders from `@402v/html-kit-core`; import an `ArtifactThemeV1` object separately and pass it as `theme` to `buildNote`, `buildInteractiveArtifact`, or `updateArtifactData`. Core never resolves specifiers. | Replace the absolute import example; show a theme import/object and required `theme` arguments. Keep specifier resolution strictly in CLI guidance. | `README.md` custom-theme section; `docs/architecture.md` public API/signatures; `docs/theme-contract-v1.md`; `packages/core/package.json` exports. |
| Manifest contract | Teaches `contractVersion: 1` and no manifest `theme`. | New interactive manifests use `contractVersion: 2`, `mode: "interactive"`, and may set `theme`; the CLI applies normal precedence. | Update the manifest example to contract v2 and include an optional `theme` field. | `docs/migration-from-internal-v1.md` requires the current contract-v2 manifest; `README.md` says the manifest may select a theme; `docs/artifact-contract-v2.md`. |
| Contract-v2 identifiers/runtime | Teaches legacy `402v-*`, `data-402v-*`, and `window.__402vArtifact`. | v2 uses neutral `html-kit-*` metadata, `[data-html-kit-root]`, `data-html-kit-*` protocol attributes, and the frozen `window.__htmlKitArtifact` API (`getData`, `dataIds`, `root`). | Replace all legacy identifiers/API examples; make clear that core, not a theme, owns the protocol. | `docs/artifact-contract-v2.md` required identifiers/runtime; `docs/migration-from-internal-v1.md` legacy identifier summary. |
| v1 read compatibility | Treats v1 as the current write contract and has no compatibility split. | CLI/core verify v1 and v2; `verifyArtifact`, `verifyArtifactHtml`, and `extractDataBlocks` read v1. Verification never rewrites bytes. A verified v1 note may still use remote resources and is not covered by the v2 offline guarantee. | Add a read-only v1 lane: detect/verify/extract, preserve original bytes, and never describe successful v1 verification as v2/offline migration. | `docs/migration-from-internal-v1.md` supported reads; `README.md` offline guarantee. |
| Explicit v1 interactive upgrade | Shows ordinary `update-data` only. | Updating v1 without authorization fails `CONTRACT_UPGRADE_REQUIRED`; interactive migration requires `update-data ... --upgrade-contract 2` (or `upgradeContract: 2` in core), a current v2 manifest, and a selected Theme Contract v1 object. | Add an explicit upgrade recipe and distinguish it from in-place v2 updates; state that no silent or bulk rewrite occurs. | `docs/migration-from-internal-v1.md` explicit interactive upgrade; `docs/security-model.md` error families. |
| v1 note limitation | No rule. | A v1 note is verify/read-only in the Kit; there is no in-place note upgrade. Rebuild from the original Markdown to obtain v2. | Add the rebuild-only limitation and do not suggest `update-data` or preservation flags for notes. | `docs/migration-from-internal-v1.md` current limitation; `README.md` offline guarantee. |
| `--preserve-data-from` | Says it verifies the source and overlays canonical blocks during rebuild. | The parser accepts `build-artifact --preserve-data-from <html>`, but execution intentionally returns `COMMAND_UNAVAILABLE`; it is not a migration route. | Mark the flag unavailable and remove it from recommended workflows until implementation lands. | `README.md` CLI reference/structured output; `docs/migration-from-internal-v1.md` current limitation. |
| Verification and structured errors | Gives interactive checklist and says commands are structured, but mixes stdout/stderr claims and lacks the stable families. | Use `402v-html-kit verify artifact.html [--required-block id]...`; core exposes `verifyArtifact`/`verifyArtifactHtml`. Every CLI command emits one JSON value; failures exit non-zero with stable families such as `INVALID_CLI_ARGUMENTS`, `ARTIFACT_VERIFICATION_FAILED`, `CONTRACT_UPGRADE_REQUIRED`, and `COMMAND_UNAVAILABLE`. | Replace wrapper verification commands; require branching on `error.code`, not messages, and avoid claiming a separate stderr object contract. Retain build-twice/browser/offline checks where applicable. | `README.md` CLI output contract; `docs/artifact-contract-v2.md` verification; `docs/security-model.md` structured failures. |
| Trusted local code boundary | Correctly calls manifest, renderer, slots, styles, and scripts trusted, but frames the verifier mainly around the old consumer model. | Themes, manifests, renderers, consumer JS/CSS, and installed dependencies are trusted local code; workers/bounds are not a sandbox. Markdown/JSON are untrusted data, and final HTML is validated. | Extend the warning to theme modules and dependency graphs; prohibit remote loaders/automatic installation and do not present verification as sandboxing trusted code. | `docs/security-model.md` inputs/trust; `docs/theme-contract-v1.md` trust warning; `docs/architecture.md`. |
| Site publication boundary | Directs an authorized request to the legacy `publish:html` procedure inside `glaucon-politeia`. | OSS packages stop at verified local HTML and perform no CMS/database/account/storage/hosting/deployment write. Site publication is a separate workflow and requires explicit authorization. | Remove direct site commands from this Skill. Route publication **exclusively to `402v-html-publisher`**, and only after explicit authorization; local generation, verification, migration, dry-run, or Skill application never grants it. | `README.md` project boundary; `docs/architecture.md` downstream concerns; `docs/security-model.md` release/external systems; current live `references/publishing.md` shows the obsolete coupling. |
| Release acceptance and independent gates | Has delivery checks but no OSS release evidence or gate separation. | Local acceptance records `npm ci`, `npm run typecheck`, site-gated/full tests, compatibility/browser tests, `npm run pack:check`, online production audit, and `git diff --check`, with exact RC totals/hashes in the checklist. Public GitHub, npm publication, site merge/deploy, and Skill apply remain unexecuted external decisions. | Cite the recorded evidence; do not rerun or imply external release. Present GitHub, npm, site publication, and Skill proposal/apply as four separate authorization gates. | `docs/release-checklist.md` status, local verification gates, compatibility/site evidence, and known limitations. |

## Release-gate handoff

The Skill proposal may be drafted from this matrix without opening any release
gate. Acceptance evidence is already recorded in `docs/release-checklist.md`:

```sh
npm ci
npm run typecheck
HTML_KIT_SITE_WORKTREE=<site-worktree> npm test
npm test -- tests/compatibility
npm test -- tests/browser
npm run pack:check
npm audit --omit=dev --json
git diff --check
```

These commands and the recorded hashes/totals support the **local RC** only.
The following remain independent, explicit decisions: (1) GitHub creation,
protection, push, and tag; (2) npm scope/trusted-publisher setup and publish;
(3) site integration, publication, or deploy through `402v-html-publisher`; and
(4) `402v-html-workflow` Skill proposal review and apply. Passing one gate does
not authorize another.
