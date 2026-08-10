# Security and resource model

## Inputs and trust

Markdown and JSON values are untrusted data: they are strictly decoded, parsed,
canonicalized, bounded, and escaped. Artifact files are regular local files
read as strict UTF-8. Writes are local and atomic.

Theme modules, manifests, renderers, consumer JavaScript, consumer CSS, and
their installed dependencies are trusted local code. Theme and renderer import
or execution is not sandboxed. The CLI uses bounded workers and snapshots local
theme graphs to reduce races, but those controls do not turn chosen code into
untrusted code. There is no remote plugin loader or automatic installation.

Final HTML validation rejects external active resources, unsafe CSS and
JavaScript, event attributes, protocol shadowing, inaccessible or external SVG,
noncanonical data, invalid ordering, source-hash mismatch, overflow hazards,
and failed interactive startup. Passive navigation links remain possible.

## Public artifact limits

`ARTIFACT_RESOURCE_LIMITS` is frozen and currently contains:

| Resource | Limit |
| --- | ---: |
| Complete artifact | 67,108,864 bytes |
| Data blocks | 32 |
| Stylesheet entries | 16 |
| Consumer script entries | 16 |
| SVG assets | 16 |
| Aggregate raw JSON | 33,554,432 bytes |
| Canonical JSON nodes | 250,000 |
| Aggregate stylesheet | 8,388,608 bytes |
| Aggregate consumer scripts | 8,388,608 bytes |
| Aggregate SVG | 20,971,520 bytes |
| One renderer slot | 4,194,304 bytes |
| Aggregate renderer slots | 8,388,608 bytes |

Additional parser-specific bounds apply, including JSON depth, CLI argument and
worker-output budgets, local file/graph limits, HTML/SVG element depth/count,
and startup timeouts. Those internal guards may become stricter without
increasing these public aggregate ceilings.

## Structured failures

Public failures use `ArtifactBuildError` with a stable `code`, sanitized
`message`, and optional JSON-safe `details`. `toJSON()` returns:

```json
{"ok":false,"error":{"code":"INVALID_DATA_BLOCK","message":"...","details":{}}}
```

The main top-level families include `INVALID_BUILD_OPTIONS`,
`INVALID_CLI_ARGUMENTS`, `INVALID_MANIFEST`, `INVALID_MARKDOWN`,
`INVALID_DATA_BLOCK`, `INVALID_THEME`, `THEME_RENDER_FAILED`,
`THEME_RESOLUTION_FAILED`, `INVALID_JAVASCRIPT`, `INVALID_STYLESHEET`,
`UNSAFE_SVG`, `UNSAFE_THEME_OUTPUT`, `RESOURCE_LIMIT_EXCEEDED`,
`NON_DETERMINISTIC_BUILD`, `OUTPUT_EXISTS`, `ATOMIC_WRITE_FAILED`,
`ARTIFACT_READ_FAILED`, `UNSUPPORTED_ARTIFACT_CONTRACT`,
`ARTIFACT_VERIFICATION_FAILED`, `INVALID_VERIFY_OPTIONS`,
`INVALID_UPDATE_OPTIONS`, `CONTRACT_UPGRADE_REQUIRED`, and
`COMMAND_UNAVAILABLE`. Verification failures carry bounded issue objects in
`details.issues`; callers must branch on codes rather than message text.

The CLI emits the same shape as its single stdout JSON value and exits non-zero.
Unexpected worker failures are normalized without leaking local source or
credentials.

## Release and external systems

Package archives are allowlisted and scanned for secrets, local paths, and
site-only identifiers. Production licenses are allowlisted and production
advisories are gated. Release automation uses a signed annotated tag and npm
trusted publishing with provenance; it intentionally has no npm token secret.

Publishing HTML, configuring a CMS/database, hosting, and applying delivery
headers are outside this security boundary. See [SECURITY.md](../SECURITY.md)
for private vulnerability reporting and [CONTRIBUTING.md](../CONTRIBUTING.md)
for release ownership.
