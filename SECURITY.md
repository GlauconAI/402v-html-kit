# Security policy

## Supported versions

There is no public npm release yet. Until the first release is published, only
the current release-candidate branch is evaluated for fixes. After publication,
GlauconAI intends to support the latest released minor line; a concrete support
table will replace this statement when more than one line exists.

## Reporting a vulnerability

Do not disclose a suspected vulnerability in a public issue. Report it
privately to a GlauconAI maintainer through an existing verified private
contact channel and include affected version or commit, reproduction steps,
impact, and any proposed mitigation. A dedicated GitHub private reporting
channel must be configured as an external repository-setup gate before public
release; this document does not claim that channel already exists.

Maintainers will acknowledge a usable report, reproduce it, determine affected
versions, prepare tests and a fix, and coordinate disclosure. No response-time
or bounty promise is made.

## Trust boundary

Markdown and JSON are treated as untrusted bounded data. In contrast, themes
execute as trusted local build-time code and are not sandboxed. Local manifests,
renderers, consumer JavaScript, consumer CSS, and installed npm dependencies are
also trusted inputs selected by the caller. They can execute with the authority
of the Node.js build process during module import or rendering.

Only install and select code you have reviewed. The Kit does not support remote
theme URLs, remote manifests, automatic theme installation, or runtime theme
downloads. Output validation constrains what a theme can place in the final
artifact, but it does not make the build-time module safe to execute.

For the complete model and hard limits, see
[docs/security-model.md](docs/security-model.md).
