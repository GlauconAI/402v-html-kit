import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { detectArtifactContract, verifyArtifactHtml } from "../src/index.mjs";

describe("artifact contract detection", () => {
  it("recognizes frozen v1 note and interactive artifacts", () => {
    for (const name of ["note", "interactive"]) {
      const html = readFileSync(
        new URL(`../../../tests/compatibility/fixtures/v1/${name}.html`, import.meta.url),
        "utf8",
      );
      expect(detectArtifactContract(html)).toEqual({
        version: 1,
        mode: name === "note" ? "note" : "interactive",
      });
      expect(verifyArtifactHtml(html).contractVersion).toBe(1);
    }
  });

  it("rejects absent, conflicting, and unsupported contracts", () => {
    expect(() => detectArtifactContract("<!doctype html><title>x</title>")).toThrow(
      /UNSUPPORTED_ARTIFACT_CONTRACT/,
    );
    expect(() =>
      detectArtifactContract('<meta name="html-kit-artifact-contract" content="3">'),
    ).toThrow(/UNSUPPORTED_ARTIFACT_CONTRACT/);
  });
});
