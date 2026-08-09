import { JSDOM } from "jsdom";

import { ArtifactBuildError } from "./errors.mjs";

function protocolMetas(document, name) {
  return [...document.querySelectorAll(`meta[name="${name}"]`)];
}

function unsupportedContract() {
  throw new ArtifactBuildError(
    "UNSUPPORTED_ARTIFACT_CONTRACT",
    "Artifact contract is missing, conflicting, or unsupported",
  );
}

export function detectArtifactContract(html) {
  const document = new JSDOM(html).window.document;
  const neutralContracts = protocolMetas(document, "html-kit-artifact-contract");
  const neutralModes = protocolMetas(document, "html-kit-artifact-mode");
  const legacyModes = protocolMetas(document, "402v-artifact-mode");

  if (neutralContracts.length > 0) {
    const mode = neutralModes[0]?.getAttribute("content");
    if (
      neutralContracts.length !== 1 ||
      neutralContracts[0].getAttribute("content") !== "2" ||
      neutralModes.length !== 1 ||
      (mode !== "note" && mode !== "interactive") ||
      legacyModes.length !== 0
    ) {
      unsupportedContract();
    }
    return { version: 2, mode };
  }

  if (neutralModes.length > 0) unsupportedContract();

  const generators = protocolMetas(document, "generator");
  if (
    generators.length !== 1 ||
    generators[0].getAttribute("content") !== "402v HTML Note Kit"
  ) {
    unsupportedContract();
  }
  if (legacyModes.length === 0 && document.querySelector("article.note-article")) {
    return { version: 1, mode: "note" };
  }
  if (
    legacyModes.length === 1 &&
    legacyModes[0].getAttribute("content") === "interactive"
  ) {
    return { version: 1, mode: "interactive" };
  }
  unsupportedContract();
}
