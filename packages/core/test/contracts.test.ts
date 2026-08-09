import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  ArtifactBuildError,
  detectArtifactContract,
  verifyArtifactHtml,
} from "../src/index.mjs";

function expectUnsupported(html: string) {
  expect(() => detectArtifactContract(html)).toThrow(/UNSUPPORTED_ARTIFACT_CONTRACT/);
}

function captureArtifactError(callback: () => unknown) {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArtifactBuildError);
  return caught as ArtifactBuildError;
}

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

  it("recognizes a complete neutral v2 discriminator", () => {
    const html = [
      '<meta name="html-kit-artifact-contract" content="2">',
      '<meta name="html-kit-artifact-mode" content="interactive">',
    ].join("");
    expect(detectArtifactContract(html)).toEqual({ version: 2, mode: "interactive" });
  });

  it("interprets protocol meta names case-insensitively", () => {
    expect(
      detectArtifactContract(
        [
          '<meta name="HTML-KIT-ARTIFACT-CONTRACT" content="2">',
          '<meta name="Html-Kit-Artifact-Mode" content="note">',
        ].join(""),
      ),
    ).toEqual({ version: 2, mode: "note" });
    expect(
      detectArtifactContract(
        [
          '<meta name="GeNeRaToR" content="402v HTML Note Kit">',
          '<meta name="402V-ARTIFACT-MODE" content="interactive">',
        ].join(""),
      ),
    ).toEqual({ version: 1, mode: "interactive" });
  });

  it("rejects absent, conflicting, and unsupported contracts", () => {
    expectUnsupported("<!doctype html><title>x</title>");
    expectUnsupported('<meta name="html-kit-artifact-contract" content="3">');
  });

  it("rejects present-but-empty protocol metadata", () => {
    const legacyInteractive = [
      '<meta name="generator" content="402v HTML Note Kit">',
      '<meta name="402v-artifact-mode" content="interactive">',
    ].join("");
    for (const neutralContract of [
      '<meta name="html-kit-artifact-contract" content="">',
      '<meta name="html-kit-artifact-contract">',
    ]) {
      expectUnsupported(`${neutralContract}${legacyInteractive}`);
    }

    const legacyNote = [
      '<meta name="generator" content="402v HTML Note Kit">',
      '<article class="note-article">note</article>',
    ].join("");
    for (const legacyMode of [
      '<meta name="402v-artifact-mode" content="">',
      '<meta name="402v-artifact-mode">',
    ]) {
      expectUnsupported(`${legacyMode}${legacyNote}`);
    }
  });

  it("rejects duplicate protocol metadata", () => {
    expectUnsupported(
      [
        '<meta name="html-kit-artifact-contract" content="2">',
        '<meta name="html-kit-artifact-contract" content="3">',
        '<meta name="html-kit-artifact-mode" content="note">',
      ].join(""),
    );
    expectUnsupported(
      [
        '<meta name="html-kit-artifact-contract" content="2">',
        '<meta name="html-kit-artifact-contract" content="2">',
        '<meta name="html-kit-artifact-mode" content="note">',
      ].join(""),
    );
    expectUnsupported(
      [
        '<meta name="html-kit-artifact-contract" content="2">',
        '<meta name="html-kit-artifact-mode" content="note">',
        '<meta name="html-kit-artifact-mode" content="interactive">',
      ].join(""),
    );
    expectUnsupported(
      [
        '<meta name="generator" content="402v HTML Note Kit">',
        '<meta name="402v-artifact-mode" content="interactive">',
        '<meta name="402v-artifact-mode" content="interactive">',
      ].join(""),
    );
    expectUnsupported(
      [
        '<meta name="generator" content="402v HTML Note Kit">',
        '<meta name="generator" content="402v HTML Note Kit">',
        '<meta name="402v-artifact-mode" content="interactive">',
      ].join(""),
    );
  });

  it("rejects mixed-version and orphan protocol metadata", () => {
    expectUnsupported(
      [
        '<meta name="html-kit-artifact-contract" content="2">',
        '<meta name="html-kit-artifact-mode" content="note">',
        '<meta name="402v-artifact-mode">',
      ].join(""),
    );
    expectUnsupported(
      [
        '<meta name="html-kit-artifact-mode" content="note">',
        '<meta name="generator" content="402v HTML Note Kit">',
        '<article class="note-article">note</article>',
      ].join(""),
    );
  });

  it("rejects case-varied duplicate, orphan, and mixed protocol metadata", () => {
    const cases = [
      [
        '<meta name="html-kit-artifact-contract" content="2">',
        '<meta name="HTML-KIT-ARTIFACT-CONTRACT" content="2">',
        '<meta name="html-kit-artifact-mode" content="note">',
      ],
      [
        '<meta name="html-kit-artifact-contract" content="2">',
        '<meta name="html-kit-artifact-mode" content="note">',
        '<meta name="HTML-KIT-ARTIFACT-MODE" content="note">',
      ],
      [
        '<meta name="generator" content="402v HTML Note Kit">',
        '<meta name="402v-artifact-mode" content="interactive">',
        '<meta name="402V-ARTIFACT-MODE" content="interactive">',
      ],
      [
        '<meta name="generator" content="402v HTML Note Kit">',
        '<meta name="GENERATOR" content="402v HTML Note Kit">',
        '<meta name="402v-artifact-mode" content="interactive">',
      ],
      [
        '<meta name="HTML-KIT-ARTIFACT-MODE" content="note">',
        '<meta name="generator" content="402v HTML Note Kit">',
        '<article class="note-article">note</article>',
      ],
      [
        '<meta name="html-kit-artifact-contract" content="2">',
        '<meta name="html-kit-artifact-mode" content="note">',
        '<meta name="402V-ARTIFACT-MODE" content="interactive">',
      ],
    ];
    for (const elements of cases) expectUnsupported(elements.join(""));
  });

  it("rejects non-string inputs without coercion", () => {
    for (const input of [undefined, null, 0, false, {}, []]) {
      expect(captureArtifactError(() => detectArtifactContract(input as never))).toMatchObject({
        code: "UNSUPPORTED_ARTIFACT_CONTRACT",
      });
      expect(captureArtifactError(() => verifyArtifactHtml(input as never))).toMatchObject({
        code: "ARTIFACT_VERIFICATION_FAILED",
        details: {
          issues: [
            {
              code: "INVALID_HTML_INPUT",
              message: "Artifact HTML must be a string",
            },
          ],
        },
      });
    }

    let coercions = 0;
    const hostile = {
      toString() {
        coercions += 1;
        throw new Error("input coercion must not run");
      },
    };
    expect(captureArtifactError(() => detectArtifactContract(hostile as never))).toMatchObject({
      code: "UNSUPPORTED_ARTIFACT_CONTRACT",
    });
    expect(captureArtifactError(() => verifyArtifactHtml(hostile as never))).toMatchObject({
      code: "ARTIFACT_VERIFICATION_FAILED",
      details: { issues: [{ code: "INVALID_HTML_INPUT" }] },
    });
    expect(coercions).toBe(0);
  });
});
