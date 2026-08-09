import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractDataBlocks } from "@402v/html-kit-core";

const interactivePath = new URL("./fixtures/v1/interactive.html", import.meta.url);
const notePath = new URL("./fixtures/v1/note.html", import.meta.url);

function sha256(value: Buffer) {
  return createHash("sha256").update(value).digest("hex");
}

describe("frozen contract-v1 primitives", () => {
  it("matches the reviewed fixture digests", () => {
    const interactive = readFileSync(interactivePath);
    const note = readFileSync(notePath);

    expect({ interactive: sha256(interactive), note: sha256(note) }).toEqual({
      interactive: "56763f265a8616c3a305727adcf6a8fd901ccf77e4d214aebf5b11d47bff51a0",
      note: "d47f767122691fe061d9d7f1948e87b4fdec49b13ef7a860afddd77e5131a056",
    });
  });

  it("extracts the canonical interactive blocks", () => {
    const interactive = readFileSync(interactivePath);
    const html = interactive.toString("utf8");

    expect([...extractDataBlocks(html).keys()]).toEqual(["project-registry"]);
  });
});
