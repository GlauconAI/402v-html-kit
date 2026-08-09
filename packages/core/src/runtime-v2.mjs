import { DATA_BLOCK_ID } from "./data-blocks.mjs";
import { ArtifactBuildError } from "./errors.mjs";

export function renderArtifactRuntimeV2(dataBlockIds = []) {
  if (!Array.isArray(dataBlockIds)) {
    throw new ArtifactBuildError(
      "INVALID_DATA_BLOCK",
      "Artifact runtime data block IDs must be an array",
    );
  }
  const ids = [];
  const seen = new Set();
  for (const id of dataBlockIds) {
    if (typeof id !== "string" || !DATA_BLOCK_ID.test(id) || seen.has(id)) {
      throw new ArtifactBuildError(
        "INVALID_DATA_BLOCK",
        "Artifact runtime requires unique valid data block IDs",
      );
    }
    seen.add(id);
    ids.push(id);
  }
  ids.sort();
  return `<script data-html-kit-runtime>
(() => {
  "use strict";
  const ids = Object.freeze(${JSON.stringify(ids)});
  window.__htmlKitArtifact = Object.freeze({
    getData(id) {
      if (!ids.includes(id)) return undefined;
      return JSON.parse(document.getElementById(id).textContent);
    },
    dataIds() { return ids.slice(); },
    root: document.querySelector("[data-html-kit-root]"),
  });
})();
</script>`;
}
