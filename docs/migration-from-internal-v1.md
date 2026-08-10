# Migration from internal contract v1

Contract-v1 artifacts use the legacy `402v-*`, `data-402v-*`, and
`window.__402vArtifact` protocol. Compatibility is read-oriented: existing
files are never rewritten merely because they are verified.

## Supported reads

`verifyArtifact({ path })`, `verifyArtifactHtml(html)`, and the CLI `verify`
detect and verify both v1 and v2. `extractDataBlocks(html)` extracts canonical
JSON from v1 and v2. Successful v1 verification reports `contractVersion: 1`
and the detected `note` or `interactive` mode.

```sh
npm exec -- 402v-html-kit verify old-artifact.html
```

Verification does not upgrade or normalize the bytes.

Legacy note verification intentionally retains the old resource behavior. A v1
note may contain remote images or styles and can make a network request; passing
v1 verification is not the contract-v2 offline guarantee. Rebuild the original
Markdown as v2 when strict offline behavior is required.

## Explicit interactive upgrade

Data updates apply only to interactive artifacts. A v1 update without explicit
authorization fails before writing with `CONTRACT_UPGRADE_REQUIRED`:

```sh
npm exec -- 402v-html-kit update-data old.html --manifest artifact.mjs --id dashboard --input replacement.json --upgrade-contract 2 --output upgraded.html
```

The manifest must be the current contract-v2 manifest used to rebuild the
artifact, and a theme is selected by CLI flag, manifest, or the official
default. Core verifies the original v1 file, preserves every canonical block,
replaces the selected block, builds deterministic v2 bytes, verifies them, and
installs atomically. The result reports old/new contracts, theme identity,
source/output hashes, preserved block IDs, and output path. Failure leaves the
original byte-identical.

Programmatic callers use `updateArtifactData` with `upgradeContract: 2` and an
imported Theme Contract v1 object. There is no silent bulk migration and no
automatic rewrite of published artifacts.

## Current limitation

The CLI parser exposes `build-artifact --preserve-data-from <html>` for contract
continuity, but the current worker intentionally rejects it with
`COMMAND_UNAVAILABLE`. It does not currently extract from v1 and rebuild.
Use the explicit `update-data --upgrade-contract 2` path for an existing
interactive artifact. A v1 note can still be verified and read, but the Kit has
no in-place v1-note upgrade command; rebuild it from its Markdown source.

The open-source project does not publish upgraded bytes. Any downstream storage
or website migration is separately owned and authorized.
