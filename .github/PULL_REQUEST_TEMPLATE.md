## Summary

- Describe the bounded problem and the package or contract that owns the change.
- Describe the implemented behavior and any known limitation.

## Verification checklist

- [ ] I used TDD: affected behavior has a focused test that failed for the expected reason before the implementation.
- [ ] `npm run typecheck` passes.
- [ ] The full test suite (`npm test`) passes, including real-Chrome browser coverage.
- [ ] Note, interactive, or custom-theme outputs affected by this change remain deterministic across repeated builds.
- [ ] `npm run pack:check` passes its tarball, clean-consumer, license, and forbidden-content scans.
- [ ] `npm audit --omit=dev` passes, or a documented security exception has explicit approval.
- [ ] The trusted-code, offline-artifact, resource-limit, and no-publisher security boundaries remain intact or are explicitly reviewed.
- [ ] Public API, CLI, contract, security, and migration documentation is updated where behavior changed.
- [ ] `CHANGELOG.md` is updated when the change is user-visible or release-relevant.
- [ ] No package publish, repository mutation, website deploy, or other external write was performed unless separately and explicitly authorized.
