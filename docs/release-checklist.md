# 402v HTML Kit 0.1.0 local release checklist

Status: **local release candidate only**. No GitHub repository, npm package,
Skill proposal, website branch, or production deployment was created, applied,
published, pushed, merged, or deployed by these checks.

The JSON block is the machine-readable record consumed by
`tests/release/acceptance.test.ts`. The prose below records how every value was
reproduced on 2026-08-10 (America/Vancouver).

<!-- release-evidence:start -->
```json
{
  "schemaVersion": 1,
  "releaseVersion": "0.1.0",
  "commits": {
    "baseline": "9527b4fd8c3ff3c49180516440f715a6d1798c8f",
    "oss": "59f01074c7daca6de38e30550fea2ca4335d0eff",
    "siteIntegration": "f7b2a60c522f3cba48168de8a70e5642ef58fab2"
  },
  "testTotals": {
    "baseline": { "files": 105, "tests": 703 },
    "oss": { "files": 23, "tests": 393 },
    "site": { "files": 96, "passed": 524, "skipped": 1 }
  },
  "packages": [
    {
      "path": "packages/core",
      "name": "@402v/html-kit-core",
      "version": "0.1.0",
      "tarball": "402v-html-kit-core-0.1.0.tgz",
      "sha256": "7154ae884070decc5ca2fb2484cf09ce5e16322cc6a176ea9509a2347d815bed",
      "fileCount": 38
    },
    {
      "path": "packages/theme-402v",
      "name": "@402v/theme-402v",
      "version": "0.1.0",
      "tarball": "402v-theme-402v-0.1.0.tgz",
      "sha256": "144c9de1b6a8146c1ac321a41ef2a72a7ea7678326d74b684bcaa835307acab4",
      "fileCount": 6
    },
    {
      "path": "packages/cli",
      "name": "@402v/html-kit-cli",
      "version": "0.1.0",
      "tarball": "402v-html-kit-cli-0.1.0.tgz",
      "sha256": "18662c622a6b49ad11b5a9a1881af860a1565bfba2e12af891fd4df9adc02a95",
      "fileCount": 5
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
    "bytes": 16084,
    "sha256": "d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056",
    "focusedTests": 14
  }
}
```
<!-- release-evidence:end -->

## Environment and immutable inputs

```text
$ node --version
v25.9.0
$ npm --version
11.12.1
$ git rev-parse HEAD
59f01074c7daca6de38e30550fea2ca4335d0eff
```

- Extraction/source baseline:
  `glaucon-politeia@9527b4fd8c3ff3c49180516440f715a6d1798c8f`.
  The approved clean-baseline run was **105 test files / 703 tests**.
- Open-source package source under acceptance:
  `402v-html-kit@59f01074c7daca6de38e30550fea2ca4335d0eff`.
- Local-only site adapter:
  `glaucon-politeia@f7b2a60c522f3cba48168de8a70e5642ef58fab2`.
- `package.json` in all three package directories reports `0.1.0`, and
  `CHANGELOG.md` contains `[0.1.0]`.

The tarballs were produced with a private temporary npm cache and
`npm pack --ignore-scripts --workspace <name>`. `shasum -a 256 *.tgz`
returned the three SHA-256 values in the evidence block. Independently,
`npm run pack:check` parsed the tar payloads and reported 38 core files, six
theme files, and five CLI files.

## Local verification gates

| Gate | Exact command | Recorded result |
| --- | --- | --- |
| clean lock install | `npm ci` | exit 0; lockfile-only install |
| declarations | `npm run typecheck` | exit 0 |
| full OSS suite | `npm test` | 23 files; 393 tests passed; real-Chrome cases included |
| v1 compatibility | `npm test -- tests/compatibility` | frozen hashes, contract-v1 mutation rejection, and explicit contract-v1 upgrade passed |
| browser acceptance | `npm test -- tests/browser` | desktop/mobile note, interactive, and custom-theme cases passed with zero external requests |
| package boundary | `npm run pack:check` | clean offline consumer passed; file counts 5/38/6; 148 production license entries |
| production audit | `npm audit --omit=dev` | 0 high; 0 critical; 0 total production vulnerabilities |
| license scan | `npm run pack:check` | all 148 package/version rows matched the reviewed SPDX allowlist |
| forbidden/secret scan | `npm run pack:check` | no credential, private-infrastructure, host-path, or unapproved brand hit |
| formatting | `git diff --check` | exit 0 |

The release aggregator reruns the clean packed consumer directly, invokes only
the isolated packed-example test (it never recursively invokes the root test
suite), recomputes fixture and example hashes, repacks all three workspaces,
and performs a cached/offline production audit. A networked production audit
was also run as the explicit release gate above.

## Deterministic contract-v2 examples

The source files were copied to a new temporary directory, built twice through
the CLI, verified as contract v2, and hashed. The results were:

```text
note          16351 bytes  496947be80e64d446fde0a5fe998a5e132de7f6043dacc07946f55ce4b13b6bc
interactive   16585 bytes  80cc0e39f90d06dc78409895e6ffa7098a70e44406f596164d75a97ab27705b2
custom theme   1596 bytes  f40ec6a6b02e6c75d06f94edb26f90646e0812548f1050d6b2e9a645001ec7aa
```

The packed-consumer test separately proves that the same three source classes
build and verify without resolving workspace packages or host `node_modules`.

## Compatibility and site-adapter evidence

`npm test -- tests/compatibility` proves that mutated v1 bytes are rejected,
that updates without `upgradeContract: 2` fail with
`CONTRACT_UPGRADE_REQUIRED`, and that an explicit contract-v1 upgrade produces
deterministic verified contract-v2 bytes without mutating its source.

In the isolated site-integration worktree, this focused command was run:

```text
$ npm test -- tests/publish-html-cli.test.ts
Test Files  1 passed (1)
Tests       14 passed (14)
```

The dry-run test sends the same strictly decoded string that passed package
verification. Its source and payload are each **16,084 bytes**, with SHA-256
`d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056`.
That value is also recomputed from the local frozen fixture by the release
aggregator. The complete site suite at the integration commit measured 96 test
files, 524 passed tests, and one opt-in clean-export test skipped; its dedicated
clean-export install gate passed separately.

## Known limitations and Rollback

- Public GitHub creation/push, tag ruleset setup, npm trusted-publisher setup,
  npm publication, Skill application, site merge/push, and production deploy
  remain explicit external gates.
- The release workflow is prepared and locally simulated, but trusted OIDC
  provenance can only be proven after GitHub and npm setup is explicitly
  authorized.
- Contract v1 is a frozen read/explicit-upgrade compatibility path. Contract
  v2 is the only new-write contract.
- The site adapter still uses local immutable tarballs until npm publication is
  separately approved.

Rollback points:

- OSS documentation/acceptance rollback: reset only the Task 15 commit to its
  parent `59f01074c7daca6de38e30550fea2ca4335d0eff`.
- Site migration rollback: restore the pre-integration baseline
  `9527b4fd8c3ff3c49180516440f715a6d1798c8f`; the local integration candidate
  remains available at `f7b2a60c522f3cba48168de8a70e5642ef58fab2`.

No rollback command was executed during acceptance.
