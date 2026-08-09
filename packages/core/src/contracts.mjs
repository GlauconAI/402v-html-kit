import { JSDOM } from "jsdom";

import { ArtifactBuildError } from "./errors.mjs";

export function detectArtifactContract(html) {
  const document = new JSDOM(html).window.document;
  const neutral = document.querySelector('meta[name="html-kit-artifact-contract"]')?.getAttribute("content");
  const legacyMode = document.querySelector('meta[name="402v-artifact-mode"]')?.getAttribute("content");
  const generator = document.querySelector('meta[name="generator"]')?.getAttribute("content");
  if (neutral === "2" && !legacyMode) {
    const mode = document.querySelector('meta[name="html-kit-artifact-mode"]')?.getAttribute("content");
    if (mode === "note" || mode === "interactive") return { version: 2, mode };
  }
  if (!neutral && generator === "402v HTML Note Kit") {
    if (legacyMode === "interactive") return { version: 1, mode: "interactive" };
    if (!legacyMode && document.querySelector("article.note-article")) return { version: 1, mode: "note" };
  }
  throw new ArtifactBuildError("UNSUPPORTED_ARTIFACT_CONTRACT", "Artifact contract is missing, conflicting, or unsupported");
}
