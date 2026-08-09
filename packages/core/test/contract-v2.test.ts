// @ts-expect-error jsdom does not publish declarations in this workspace.
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  ArtifactBuildError,
  assembleArtifactV2,
  verifyArtifactHtml,
} from "../src/index.mjs";

const themeOutput = {
  lang: "en",
  styles: ":root{color-scheme:dark}",
  bodyHtml: '<main data-page="x">Hello</main>',
};

function expectUnsafeJavaScript(callback: () => unknown) {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArtifactBuildError);
  expect((caught as ArtifactBuildError).details).toMatchObject({
    issues: expect.arrayContaining([
      expect.objectContaining({ code: "UNSAFE_JAVASCRIPT" }),
    ]),
  });
}

describe("artifact contract v2", () => {
  it("owns neutral metadata, root, data, runtime, and ordering", () => {
    const html = assembleArtifactV2({
      mode: "interactive",
      metadata: { title: "Atlas", description: "", eyebrow: "", lang: "en" },
      theme: { id: "example", version: "1.0.0" },
      themeOutput,
      dataBlocks: new Map([["registry", { a: 1 }]]),
      consumerScripts: ["window.started=true;"],
    });
    expect(html).toContain('name="html-kit-artifact-contract" content="2"');
    expect(html).toContain('name="html-kit-artifact-mode" content="interactive"');
    expect(html).toContain("window.__htmlKitArtifact");
    expect(html).not.toContain("__402vArtifact");
    expect(verifyArtifactHtml(html)).toMatchObject({
      ok: true,
      contractVersion: 2,
      mode: "interactive",
    });
  });

  it("emits no runtime in note mode", () => {
    const html = assembleArtifactV2({
      mode: "note",
      metadata: { title: "Note", description: "", eyebrow: "", lang: "en" },
      theme: { id: "example", version: "1.0.0" },
      themeOutput,
      dataBlocks: new Map(),
      consumerScripts: [],
    });
    expect(html).not.toContain("data-html-kit-runtime");
    expect(verifyArtifactHtml(html).mode).toBe("note");
  });

  it("exposes the frozen neutral runtime after canonical data and before consumers", () => {
    const html = assembleArtifactV2({
      mode: "interactive",
      metadata: { title: "Atlas", description: "Map", eyebrow: "Index", lang: "en" },
      theme: { id: "example", version: "1.0.0" },
      themeOutput,
      dataBlocks: new Map([
        ["z-last", { z: true }],
        ["a-first", { nested: [1, 2] }],
      ]),
      consumerScripts: [
        'window.consumerData=window.__htmlKitArtifact.getData("a-first");',
      ],
    });
    expect(html.indexOf('id="a-first"')).toBeLessThan(html.indexOf('id="z-last"'));
    expect(html.indexOf('id="z-last"')).toBeLessThan(
      html.indexOf("data-html-kit-runtime"),
    );
    expect(html.indexOf("data-html-kit-runtime")).toBeLessThan(
      html.indexOf("data-html-kit-consumer-script"),
    );

    const dom = new JSDOM(html, { runScripts: "dangerously" });
    const runtime = (dom.window as unknown as { __htmlKitArtifact: {
      root: Element;
      dataIds(): string[];
      getData(id: string): unknown;
    } }).__htmlKitArtifact;
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(runtime.dataIds()).toEqual(["a-first", "z-last"]);
    expect(runtime.getData("missing")).toBeUndefined();
    expect(runtime.root).toBe(dom.window.document.querySelector("[data-html-kit-root]"));
    expect((dom.window as unknown as { consumerData: unknown }).consumerData).toEqual({
      nested: [1, 2],
    });
    dom.window.close();
  });

  it("is deterministic and owns neutral metadata", () => {
    const input = {
      mode: "interactive" as const,
      metadata: { title: "A & B", description: '"quoted"', eyebrow: "<top>", lang: "en" },
      theme: { id: "example-theme", version: "1.2.3" },
      themeOutput,
      dataBlocks: new Map([["registry", { b: 2, a: 1 }]]),
      consumerScripts: ["window.started=true;"],
    };
    const first = assembleArtifactV2(input);
    const second = assembleArtifactV2(input);
    expect(first).toBe(second);
    expect(first).toContain('<meta name="generator" content="402v HTML Kit">');
    expect(first).toContain('name="html-kit-theme-id" content="example-theme"');
    expect(first).toContain('name="html-kit-theme-version" content="1.2.3"');
    expect(first).toContain('name="html-kit-source-hash" content="sha256:');
    expect(first).toContain("<title>A &amp; B</title>");
    const dom = new JSDOM(first);
    expect(dom.window.document.querySelectorAll("[data-html-kit-root]")).toHaveLength(1);
    dom.window.close();
  });

  it("rejects tampered protocol, data, script order, roots, and offline safety", () => {
    const html = assembleArtifactV2({
      mode: "interactive",
      metadata: { title: "Atlas", description: "", eyebrow: "", lang: "en" },
      theme: { id: "example", version: "1.0.0" },
      themeOutput,
      dataBlocks: new Map([["registry", { a: 1 }]]),
      consumerScripts: ["window.started=true;"],
    });
    const cases = [
      html.replace('content="402v HTML Kit"', 'content="Other"'),
      html.replace(/sha256:[a-f0-9]{64}/, `sha256:${"0".repeat(64)}`),
      html.replace(
        '<div data-html-kit-root>',
        '<div data-html-kit-root><div data-html-kit-root></div>',
      ),
      html.replace(
        /(<script data-html-kit-runtime>[\s\S]*?<\/script>)\n(<script data-html-kit-consumer-script>)/,
        "$2window.before=true;</script>\n$1\n<script data-html-kit-consumer-script>",
      ),
      html.replace("</head>", '<link rel="stylesheet" href="https://example.invalid/x.css">\n</head>'),
    ];
    for (const candidate of cases) {
      expect(() => verifyArtifactHtml(candidate)).toThrow(ArtifactBuildError);
    }
  });

  it("rejects executable note entries and invalid theme or consumer assets", () => {
    const base = {
      metadata: { title: "Note", description: "", eyebrow: "", lang: "en" },
      theme: { id: "example", version: "1.0.0" },
      themeOutput,
      dataBlocks: new Map<string, unknown>(),
    };
    expect(() =>
      assembleArtifactV2({
        ...base,
        mode: "note",
        consumerScripts: ["window.started=true;"],
      }),
    ).toThrow(ArtifactBuildError);
    expect(() =>
      assembleArtifactV2({
        ...base,
        mode: "interactive",
        themeOutput: { ...themeOutput, styles: '@import "https://example.invalid/x.css";' },
        consumerScripts: [],
      }),
    ).toThrow(ArtifactBuildError);
    expect(() =>
      assembleArtifactV2({
        ...base,
        mode: "interactive",
        consumerScripts: ['import("https://example.invalid/x.js")'],
      }),
    ).toThrow(ArtifactBuildError);
  });

  it("rejects HTML and SVG event-handler attributes during assembly in both modes", () => {
    const hostileBodies = [
      '<button OnClIcK="window.clicked=true">Run</button>',
      '<svg role="img" viewBox="0 0 1 1" aria-labelledby="svg-title" oNlOaD="window.loaded=true"><title id="svg-title">Dot</title></svg>',
    ];
    for (const mode of ["note", "interactive"] as const) {
      for (const bodyHtml of hostileBodies) {
        expectUnsafeJavaScript(() =>
          assembleArtifactV2({
            mode,
            metadata: { title: "Handlers", description: "", eyebrow: "", lang: "en" },
            theme: { id: "example", version: "1.0.0" },
            themeOutput: { ...themeOutput, bodyHtml },
            dataBlocks: new Map(),
            consumerScripts: [],
          }),
        );
      }
    }
  });

  it("rejects HTML and SVG event-handler attributes during direct verification in both modes", () => {
    const hostileFragments = [
      '<button onclick="window.clicked=true">Run</button>',
      '<svg role="img" viewBox="0 0 1 1" aria-labelledby="direct-svg-title" onload="window.loaded=true"><title id="direct-svg-title">Dot</title></svg>',
    ];
    for (const mode of ["note", "interactive"] as const) {
      const html = assembleArtifactV2({
        mode,
        metadata: { title: "Handlers", description: "", eyebrow: "", lang: "en" },
        theme: { id: "example", version: "1.0.0" },
        themeOutput,
        dataBlocks: new Map(),
        consumerScripts: [],
      });
      for (const fragment of hostileFragments) {
        const candidate = html.replace("Hello</main>", `Hello${fragment}</main>`);
        expectUnsafeJavaScript(() => verifyArtifactHtml(candidate));
      }
    }
  });

  it("allows benign attributes that contain on outside the attribute-name prefix", () => {
    for (const mode of ["note", "interactive"] as const) {
      const html = assembleArtifactV2({
        mode,
        metadata: { title: "State", description: "", eyebrow: "", lang: "en" },
        theme: { id: "example", version: "1.0.0" },
        themeOutput: {
          ...themeOutput,
          bodyHtml: '<main data-on-state="onclick is only text">Safe</main>',
        },
        dataBlocks: new Map(),
        consumerScripts: [],
      });
      expect(verifyArtifactHtml(html)).toMatchObject({ ok: true, mode });
    }
  });
});
