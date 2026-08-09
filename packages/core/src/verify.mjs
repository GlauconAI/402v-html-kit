import { detectArtifactContract } from "./contracts.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { readUtf8File } from "./io.mjs";
import { failVerification, issue } from "./verify-common.mjs";
import { verifyArtifactV1Html } from "./verify-v1.mjs";
import { verifyArtifactV2Html } from "./verify-v2.mjs";

export function verifyArtifactHtml(html, options = undefined) {
  if (typeof html !== "string") {
    failVerification([issue("INVALID_HTML_INPUT", "Artifact HTML must be a string")]);
  }
  const contract = detectArtifactContract(html);
  if (contract.version === 1) return verifyArtifactV1Html(html, options);
  if (contract.version === 2) return verifyArtifactV2Html(html, options);
  throw new ArtifactBuildError(
    "UNSUPPORTED_ARTIFACT_CONTRACT",
    "Artifact verification is not implemented for this contract version",
    { version: contract.version },
  );
}

export function verifyArtifactFile(path, options = undefined) {
  let loaded;
  try {
    loaded = readUtf8File(path);
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) {
      failVerification([
        issue(
          cause.message.includes("valid UTF-8") ? "INVALID_UTF8" : "ARTIFACT_READ_FAILED",
          cause.message.includes("valid UTF-8")
            ? "Artifact file must contain strict UTF-8"
            : "Artifact file could not be read safely",
        ),
      ]);
    }
    throw cause;
  }
  return verifyArtifactHtml(loaded.content, options);
}
