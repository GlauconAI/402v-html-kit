---
title: "Offline Note Example"
description: "A deterministic note built with the official 402v theme."
eyebrow: "HTML Kit Example"
lang: "en"
---

# Offline Note Example

This note is compiled into one self-contained HTML file. It opens from disk,
requires no server, and makes no network requests.

## Deterministic by design

- The same source and theme produce the same bytes.
- Embedded styles and content remain available offline.
- The verifier checks the artifact contract before release.

```flow
flowchart LR
A[Source] --> B[Build]
B --> C[Verify]
C --> D[Offline HTML]
```
