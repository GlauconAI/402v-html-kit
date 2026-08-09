import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { detectArtifactContract, verifyArtifactHtml } from "../src/index.mjs";

function expectUnsupported(html: string) {
  expect(() => detectArtifactContract(html)).toThrow(/UNSUPPORTED_ARTIFACT_CONTRACT/);
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
});
