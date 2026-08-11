# 402v HTML Kit 0.1.0 local release checklist

Status: **local release candidate evidence**. This record verifies source and
package bytes; it is not evidence that a GitHub push, GitHub Release, npm
publication, website merge, or production deployment has completed.

The JSON block is the machine-readable record consumed by
`tests/release/acceptance.test.ts`. The prose below records how every value was
reproduced on 2026-08-11 (America/Vancouver).

<!-- release-evidence:start -->
```json
{
  "schemaVersion": 3,
  "releaseVersion": "0.1.0",
  "commits": {
    "baseline": "9527b4fd8c3ff3c49180516440f715a6d1798c8f",
    "oss": "fe86990674d2327c53b4dc4f4b234bed70e27d33",
    "siteIntegration": "f7b2a60c522f3cba48168de8a70e5642ef58fab2"
  },
  "testTotals": {
    "baseline": { "files": 105, "tests": 703 },
    "oss": { "files": 24, "packageCiTests": 395, "localRcTests": 396 },
    "site": { "files": 96, "passed": 524, "skipped": 1 }
  },
  "packages": [
    {
      "path": "packages/core",
      "name": "@402v/html-kit-core",
      "version": "0.1.0",
      "tarball": "402v-html-kit-core-0.1.0.tgz",
      "contentsSha256": "5a096b33682764cd8d4f6e38dbd4a695ea17f134d7fb07929aeff3ee718593b0",
      "fileCount": 38
    },
    {
      "path": "packages/theme-402v",
      "name": "@402v/theme-402v",
      "version": "0.1.0",
      "tarball": "402v-theme-402v-0.1.0.tgz",
      "contentsSha256": "25d42a9eb236eddc9851b1e09ec7378cbd71e9313e26d030ba41be0e5b5cfad4",
      "fileCount": 6
    },
    {
      "path": "packages/cli",
      "name": "@402v/html-kit-cli",
      "version": "0.1.0",
      "tarball": "402v-html-kit-cli-0.1.0.tgz",
      "contentsSha256": "fb5aa94064a9e76def9ee3c4705c4ba9e32679e4a46ca039abc2ff8b1961cd89",
      "fileCount": 7
    }
  ],
  "frozenV1": {
    "tests/compatibility/fixtures/v1/interactive.html": "56763f265a8616c3a305727adcf6a8fd901ccf77e4d214aebf5b11d47bff51a0",
    "tests/compatibility/fixtures/v1/note.html": "d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056"
  },
  "examples": {
    "note": {
      "bytes": 16351,
      "sha256": "496947be80e64d446fde0a5fe998a5e132de7f6043dacc07946f55ce4b13b6bc"
    },
    "interactive": {
      "bytes": 16585,
      "sha256": "80cc0e39f90d06dc78409895e6ffa7098a70e44406f596164d75a97ab27705b2"
    },
    "customTheme": {
      "bytes": 1596,
      "sha256": "f40ec6a6b02e6c75d06f94edb26f90646e0812548f1050d6b2e9a645001ec7aa"
    }
  },
  "sitePublisher": {
    "gate": "required-with-HTML_KIT_SITE_WORKTREE",
    "tree": "31b0b196aaa0a107602e0f9a5e3bcf53d456c27f",
    "bytes": 16084,
    "sha256": "d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056",
    "focusedTests": 14
  },
  "productionAudit": {
    "command": "npm audit --omit=dev --json",
    "observedAt": "2026-08-11T23:21:14Z",
    "packageLockSha256": "e525fd2bcc97ea6e4efec4c901c2890e515daf16a371e209c49654b89d4ef6dc",
    "high": 0,
    "critical": 0,
    "total": 0
  }
}
```
<!-- release-evidence:end -->

## Environment and immutable inputs

```text
$ node --version
v24.19.0
$ npm --version
11.17.0
$ git rev-parse HEAD
fe86990674d2327c53b4dc4f4b234bed70e27d33
```

- Extraction/source baseline:
  `glaucon-politeia@9527b4fd8c3ff3c49180516440f715a6d1798c8f`.
  The approved clean-baseline run was **105 test files / 703 tests**.
- Open-source package source under acceptance:
  `402v-html-kit@fe86990674d2327c53b4dc4f4b234bed70e27d33`.
- Local-only site adapter:
  `glaucon-politeia@f7b2a60c522f3cba48168de8a70e5642ef58fab2`.
- `package.json` in all three package directories reports `0.1.0`, and
  `CHANGELOG.md` contains `[0.1.0]`.

The tarballs were produced with a private temporary npm cache and
`npm pack --ignore-scripts --workspace <name>`. The evidence canonically hashes
each sorted file path, executable mode, and file body, so gzip and tar metadata
from the host or npm version cannot change the digest. Independently,
`npm run pack:check` parsed the tarballs and reported 38 core files, six theme
files, and seven CLI files.

## Local verification gates

| Gate | Exact command | Recorded result |
| --- | --- | --- |
| clean lock install | `npm ci` | exit 0; lockfile-only install |
| declarations | `npm run typecheck` | exit 0 |
| full OSS suite | `HTML_KIT_SITE_WORKTREE=<site-worktree> npm test` | 24 files; 396 tests passed; real Chrome and local cross-repository gate included |
| v1 compatibility | `npm test -- tests/compatibility` | frozen hashes, contract-v1 mutation rejection, and explicit contract-v1 upgrade passed |
| browser acceptance | `npm test -- tests/browser` | desktop/mobile note, interactive, and custom-theme cases passed with zero external requests |
| package boundary | `npm run pack:check` | clean offline consumer passed; file counts 7/38/6; 148 production license entries |
| production audit | `npm audit --omit=dev --json` | fresh registry result at `2026-08-11T23:21:14Z`: 0 high, 0 critical, 0 total; lock SHA-256 `e525fd2bcc97ea6e4efec4c901c2890e515daf16a371e209c49654b89d4ef6dc` |
| license scan | `npm run pack:check` | all 148 package/version rows matched the reviewed SPDX allowlist |
| forbidden/secret scan | `npm run pack:check` | no credential, private-infrastructure, host-path, or unapproved brand hit |
| formatting | `git diff --check` | exit 0 |

The release aggregator reruns the clean packed consumer directly, invokes only
the isolated packed-example test (it never recursively invokes the root test
suite), recomputes fixture and example hashes, and repacks all three workspaces.
It does not treat npm's offline audit output as vulnerability evidence. The
registry-backed audit above is an explicit producer/release gate; the
aggregator binds its timestamped result to the exact lockfile hash and verifies
that both CI and release workflows retain the authoritative online command.

## Deterministic contract-v2 examples

The hashes below are workspace-source CLI outputs: source files were copied to
a new temporary directory, built through the CLI, verified as contract v2, and
hashed. The results were:

```text
note          16351 bytes  496947be80e64d446fde0a5fe998a5e132de7f6043dacc07946f55ce4b13b6bc
interactive   16585 bytes  80cc0e39f90d06dc78409895e6ffa7098a70e44406f596164d75a97ab27705b2
custom theme   1596 bytes  f40ec6a6b02e6c75d06f94edb26f90646e0812548f1050d6b2e9a645001ec7aa
```

This hash record is not presented as packed-consumer output. The independent
packed-consumer test separately proves that all three source classes build
twice with identical bytes and verify without resolving workspace packages or
host `node_modules`.

## Compatibility and site-adapter evidence

`npm test -- tests/compatibility` proves that mutated v1 bytes are rejected,
that updates without `upgradeContract: 2` fail with
`CONTRACT_UPGRADE_REQUIRED`, and that an explicit contract-v1 upgrade produces
deterministic verified contract-v2 bytes without mutating its source.

The site adapter is a separate local RC gate. Public package CI has no site
checkout, so the conditional test is skipped when `HTML_KIT_SITE_WORKTREE` is
absent: package-only CI therefore records 395 passing tests plus this one
explicit skip. A local release-candidate decision is incomplete until the
variable is set to the isolated site-integration worktree and all 396 tests,
including this command, pass:

```text
$ HTML_KIT_SITE_WORKTREE=<site-worktree> npm test -- tests/release/acceptance.test.ts
Test Files  1 passed (1)
Tests       8 passed (8)
```

That gate requires exact HEAD
`f7b2a60c522f3cba48168de8a70e5642ef58fab2`, exact tree
`31b0b196aaa0a107602e0f9a5e3bcf53d456c27f`, and an empty worktree. It then
runs the site's focused publisher suite (14/14) and directly invokes the
publisher in dry-run mode. The published string and site-owned input are each
**16,084 bytes**, with SHA-256
`d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056`.
The gate compares those bytes directly; it does not infer site behavior from
the OSS fixture. The complete site suite at the integration commit measured 96
test files, 524 passed tests, and one opt-in clean-export test skipped; its
dedicated clean-export install gate passed separately.

## Known limitations and Rollback

- At the time this local record was produced, GitHub push and metadata, tag
  ruleset setup, npm trusted-publisher setup, npm publication, site merge/push,
  and production deploy remained explicit external gates.
- The release workflow is prepared and locally simulated, but trusted OIDC
  provenance can only be proven after GitHub and npm setup is explicitly
  authorized.
- Contract v1 is a frozen read/explicit-upgrade compatibility path. Contract
  v2 is the only new-write contract.
- The site adapter still uses local immutable tarballs until npm publication is
  separately approved.

Rollback points:

- Release-evidence rollback: revert the evidence commit while retaining its
  verified source parent `fe86990674d2327c53b4dc4f4b234bed70e27d33`.
- Site migration rollback: restore the pre-integration baseline
  `9527b4fd8c3ff3c49180516440f715a6d1798c8f`; the local integration candidate
  remains available at `f7b2a60c522f3cba48168de8a70e5642ef58fab2`.

No rollback command was executed during acceptance.
