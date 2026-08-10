import { createHash } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ARTIFACT_RESOURCE_LIMITS,
  ArtifactBuildError,
  buildNote,
  verifyArtifactHtml,
} from "../src/index.mjs";
import type {
  ArtifactThemeV1,
  ThemeRenderInput,
  ThemeRenderResult,
} from "../src/index.mjs";
import * as core from "../src/index.mjs";
import { renderMarkdown } from "../src/render-markdown.mjs";

const require = createRequire(import.meta.url);
const { JSDOM } = require("jsdom");
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "402v-build-note-"));
  roots.push(root);
  return root;
}

function safeTheme(
  render: (input: ThemeRenderInput) => ThemeRenderResult = (input) => ({
    lang: input.metadata.lang,
    styles: ":root{color:#111}",
    bodyHtml: `<main>${input.content.articleHtml}</main>`,
  }),
): ArtifactThemeV1 {
  return {
    themeContractVersion: 1 as const,
    id: "test-theme",
    version: "1.2.3",
    displayName: "Test Theme",
    render,
  };
}

async function expectError(run: () => Promise<unknown>, code: string) {
  let caught: unknown;
  try {
    await run();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArtifactBuildError);
  expect(caught).toMatchObject({ code, name: "ArtifactBuildError" });
  return caught as ArtifactBuildError;
}

function isDeeplyFrozen(value: unknown, seen = new Set<unknown>()): boolean {
  if (value === null || typeof value !== "object" || seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Reflect.ownKeys(value).every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor !== undefined && !("value" in descriptor) ||
      isDeeplyFrozen(descriptor?.value, seen);
  });
}

describe("buildNote", () => {
  it("is the sole addition to the twelve-export public core surface", () => {
    expect("buildNote" in core).toBe(true);
    expect(buildNote).toBeTypeOf("function");
    expect(Object.keys(core)).toHaveLength(12);
  });

  it.each([
    ["null", null],
    ["array", []],
    ["non-plain prototype", Object.assign(new (class Options {})(), {
      inputPath: "note.md",
      outputPath: "note.html",
      theme: safeTheme(),
    })],
    ["symbol property", Object.assign({
      inputPath: "note.md",
      outputPath: "note.html",
      theme: safeTheme(),
    }, { [Symbol("unsafe")]: true })],
    ["extra property", {
      inputPath: "note.md",
      outputPath: "note.html",
      theme: safeTheme(),
      themePath: "./theme.mjs",
    }],
    ["missing outputPath", { inputPath: "note.md", theme: safeTheme() }],
    ["non-string inputPath", {
      inputPath: new String("note.md"),
      outputPath: "note.html",
      theme: safeTheme(),
    }],
    ["non-string outputPath", {
      inputPath: "note.md",
      outputPath: 42,
      theme: safeTheme(),
    }],
    ["non-boolean force", {
      inputPath: "note.md",
      outputPath: "note.html",
      force: "yes",
      theme: safeTheme(),
    }],
  ])("rejects %s options without filesystem effects", async (_label, options) => {
    await expectError(
      () => buildNote(options as never),
      "INVALID_BUILD_OPTIONS",
    );
  });

  it("rejects accessors and non-enumerable options without invoking them", async () => {
    let getterCalls = 0;
    const accessor = {
      outputPath: "note.html",
      theme: safeTheme(),
    } as Record<string, unknown>;
    Object.defineProperty(accessor, "inputPath", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "note.md";
      },
    });
    await expectError(() => buildNote(accessor as never), "INVALID_BUILD_OPTIONS");
    expect(getterCalls).toBe(0);

    const hidden = {
      inputPath: "note.md",
      outputPath: "note.html",
      theme: safeTheme(),
    };
    Object.defineProperty(hidden, "force", { value: true, enumerable: false });
    await expectError(() => buildNote(hidden), "INVALID_BUILD_OPTIONS");
  });

  it("validates the required theme before reading a missing input or inspecting output", async () => {
    const root = temporaryRoot();
    const missing = join(root, "missing.md");
    const output = join(root, "output.html");

    await expectError(
      () => buildNote({ inputPath: missing, outputPath: output } as never),
      "INVALID_THEME",
    );
    await expectError(
      () => buildNote({ inputPath: missing, outputPath: output, theme: "test-theme" } as never),
      "INVALID_THEME",
    );
    expect(existsSync(output)).toBe(false);
  });

  it("preserves frontmatter, GFM, callout, heading, image, and flow rendering", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "note.md");
    const outputPath = join(root, "note.html");
    const imagePath = join(root, "pixel.png");
    writeFileSync(
      imagePath,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    writeFileSync(
      inputPath,
      [
        "---",
        'title: "Rendered Note"',
        "description: Markdown parity.",
        "eyebrow: 402v Test",
        "lang: en-US",
        "ignored: value",
        "---",
        "",
        "# Rendered Note",
        "",
        "## **Repeated**",
        "## Repeated",
        "",
        "> [!NOTE]",
        "> Kept as a callout.",
        "",
        "| A | B |",
        "| - | - |",
        "| one | two |",
        "",
        "- [x] Ready",
        "",
        "![Pixel](./pixel.png)",
        "",
        "```mermaid",
        "flowchart LR",
        "A[Source] --> B{Review}",
        "B -->|pass| C[HTML]",
        "```",
      ].join("\r\n"),
    );

    let received: any;
    let calls = 0;
    const result = await buildNote({
      inputPath,
      outputPath,
      theme: safeTheme((input) => {
        calls += 1;
        received = input;
        return {
          lang: input.metadata.lang,
          styles: ":root{color:#111}",
          bodyHtml: `<main>${input.content.articleHtml}</main>`,
        };
      }),
    });

    expect(calls).toBe(1);
    expect(isDeeplyFrozen(received)).toBe(true);
    expect(received).toMatchObject({
      mode: "note",
      metadata: {
        title: "Rendered Note",
        description: "Markdown parity.",
        eyebrow: "402v Test",
        lang: "en-US",
      },
      content: {
        headings: [
          { id: "rendered-note", level: 1, text: "Rendered Note" },
          { id: "repeated", level: 2, text: "Repeated" },
          { id: "repeated-2", level: 2, text: "Repeated" },
        ],
      },
    });
    expect(received.content.articleHtml).toContain('<h1 id="rendered-note">Rendered Note</h1>');
    expect(received.content.articleHtml).toContain('<h2 id="repeated-2">Repeated</h2>');
    expect(received.content.articleHtml).toContain('<blockquote class="callout callout-note"');
    expect(received.content.articleHtml).toContain("<table>");
    expect(received.content.articleHtml).toContain('type="checkbox"');
    expect(received.content.articleHtml).toContain("data:image/png;base64,");
    expect(received.content.articleHtml).toContain('data-diagram="flowchart"');
    expect(received.content.articleHtml).toContain('d="M 224 80 L 314 80"');
    expect(result).toMatchObject({
      ok: true,
      contractVersion: 2,
      mode: "note",
      output: outputPath,
      title: "Rendered Note",
      dataBlockIds: [],
      theme: { id: "test-theme", version: "1.2.3" },
    });
  });

  it("emits deterministic verified contract-v2 note ordering without runtime", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "note.md");
    const firstOutput = join(root, "first.html");
    const secondOutput = join(root, "second.html");
    writeFileSync(inputPath, "# Deterministic\n\nBody.\n");
    const theme = safeTheme();

    const first = await buildNote({ inputPath, outputPath: firstOutput, theme });
    const second = await buildNote({ inputPath, outputPath: secondOutput, theme });
    const firstHtml = readFileSync(firstOutput, "utf8");
    const secondHtml = readFileSync(secondOutput, "utf8");

    expect(firstHtml).toBe(secondHtml);
    expect(first.outputHash).toBe(`sha256:${createHash("sha256").update(firstHtml).digest("hex")}`);
    expect(first.bytes).toBe(Buffer.byteLength(firstHtml, "utf8"));
    expect(first.sourceHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(second.sourceHash).toBe(first.sourceHash);
    expect(verifyArtifactHtml(firstHtml)).toMatchObject({
      ok: true,
      contractVersion: 2,
      mode: "note",
      dataBlockIds: [],
    });
    expect(firstHtml.indexOf('name="html-kit-artifact-contract"')).toBeLessThan(
      firstHtml.indexOf("data-html-kit-root"),
    );
    expect(firstHtml).toContain('<meta name="html-kit-theme-id" content="test-theme">');
    expect(firstHtml).toContain('<meta name="html-kit-theme-version" content="1.2.3">');
    expect(firstHtml).not.toContain("data-402v-runtime");
    expect(firstHtml).not.toContain("data-html-kit-consumer-script");
    expect(firstHtml).not.toContain('type="application/json"');
  });

  it("preserves remote and unresolved image meaning as deterministic passive links", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "images.md");
    const firstOutput = join(root, "first.html");
    const secondOutput = join(root, "second.html");
    writeFileSync(
      inputPath,
      [
        "---",
        "title: Passive images",
        "lang: en",
        "---",
        "",
        '![Remote diagram](https://example.com/diagram.png "Remote title")',
        "",
        '![Missing local](./missing.png "Missing title")',
      ].join("\n"),
    );
    let articleHtml = "";
    const theme = safeTheme((input) => {
      articleHtml = input.content.articleHtml ?? "";
      return {
        lang: input.metadata.lang,
        styles: "",
        bodyHtml: `<main>${articleHtml}</main>`,
      };
    });

    await buildNote({ inputPath, outputPath: firstOutput, theme });
    await buildNote({ inputPath, outputPath: secondOutput, theme });
    const firstHtml = readFileSync(firstOutput, "utf8");

    expect(articleHtml).toContain(
      '<a href="https://example.com/diagram.png" title="Remote title" data-image-fallback="">Remote diagram</a>',
    );
    expect(articleHtml).toContain(
      '<a href="./missing.png" title="Missing title" data-image-fallback="">Missing local</a>',
    );
    expect(articleHtml).not.toMatch(/<img\b[^>]*\bsrc=/i);
    expect(firstHtml).not.toMatch(/<img\b[^>]*\bsrc=["']https?:/i);
    expect(verifyArtifactHtml(firstHtml)).toMatchObject({
      ok: true,
      contractVersion: 2,
      mode: "note",
    });
    expect(readFileSync(secondOutput, "utf8")).toBe(firstHtml);
  });

  it("allocates a flow title ID around an existing heading collision", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "heading-collision.md");
    const outputPath = join(root, "heading-collision.html");
    writeFileSync(
      inputPath,
      [
        "# Flow Diagram Title 1",
        "",
        "```mermaid",
        "flowchart LR",
        "A[Source] --> B[HTML]",
        "```",
      ].join("\n"),
    );
    let articleHtml = "";

    await buildNote({
      inputPath,
      outputPath,
      theme: safeTheme((input) => {
        articleHtml = input.content.articleHtml ?? "";
        return {
          lang: input.metadata.lang,
          styles: "",
          bodyHtml: `<main>${articleHtml}</main>`,
        };
      }),
    });

    expect(articleHtml).toContain('<h1 id="flow-diagram-title-1">');
    expect(articleHtml).toContain('aria-labelledby="flow-diagram-title-1-2"');
    expect(articleHtml).toContain('<title id="flow-diagram-title-1-2">Flow diagram</title>');
    expect(verifyArtifactHtml(readFileSync(outputPath, "utf8"))).toMatchObject({
      ok: true,
      contractVersion: 2,
    });
  });

  it("allocates unique local marker IDs across headings and multiple flows", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "multiple-flows.md");
    const outputPath = join(root, "multiple-flows.html");
    const secondOutput = join(root, "multiple-flows-again.html");
    writeFileSync(
      inputPath,
      [
        "# Flow Arrow",
        "",
        "```flow",
        "flowchart LR",
        "A[One] --> B[Two]",
        "```",
        "",
        "```mermaid",
        "flowchart TD",
        "C[Three] --> D[Four]",
        "```",
      ].join("\n"),
    );
    let articleHtml = "";
    const theme = safeTheme((input) => {
      articleHtml = input.content.articleHtml ?? "";
      return {
        lang: input.metadata.lang,
        styles: "",
        bodyHtml: `<main>${articleHtml}</main>`,
      };
    });

    await buildNote({ inputPath, outputPath, theme });
    await buildNote({ inputPath, outputPath: secondOutput, theme });

    const ids = [...articleHtml.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(articleHtml).toContain('<marker id="flow-arrow-2"');
    expect(articleHtml).toContain('marker-end="url(#flow-arrow-2)"');
    expect(articleHtml).toContain('<marker id="flow-arrow-3"');
    expect(articleHtml).toContain('marker-end="url(#flow-arrow-3)"');
    expect(readFileSync(secondOutput, "utf8")).toBe(
      readFileSync(outputPath, "utf8"),
    );
    expect(verifyArtifactHtml(readFileSync(outputPath, "utf8"))).toMatchObject({
      ok: true,
      contractVersion: 2,
    });
  });

  it("reserves every rendered heading ID before allocating flow identifiers", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "rendered-heading-collisions.md");
    const outputPath = join(root, "rendered-heading-collisions.html");
    writeFileSync(
      inputPath,
      [
        "Flow Diagram Title 1",
        "====",
        "",
        "```flow",
        "flowchart LR",
        "A[One] --> B[Two]",
        "```",
        "",
        "> # Flow Arrow",
        "",
        "```mermaid",
        "flowchart TD",
        "C[Three] --> D[Four]",
        "```",
        "",
        "   # Flow Diagram Title 2",
      ].join("\n"),
    );
    let articleHtml = "";
    let returnedHeadings: ThemeRenderInput["content"]["headings"];

    await buildNote({
      inputPath,
      outputPath,
      theme: safeTheme((input) => {
        articleHtml = input.content.articleHtml ?? "";
        returnedHeadings = input.content.headings;
        return {
          lang: input.metadata.lang,
          styles: "",
          bodyHtml: `<main>${articleHtml}</main>`,
        };
      }),
    });

    const dom = new JSDOM(articleHtml);
    try {
      const { document } = dom.window;
      const ids = [...document.querySelectorAll("[id]")].map((element) => element.id);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(expect.arrayContaining([
        "flow-diagram-title-1",
        "flow-diagram-title-2",
        "flow-arrow",
      ]));

      for (const svg of document.querySelectorAll("svg[aria-labelledby]")) {
        const labelledBy = svg.getAttribute("aria-labelledby")?.split(/\s+/) ?? [];
        expect(labelledBy.length).toBeGreaterThan(0);
        for (const id of labelledBy) {
          expect(document.getElementById(id)?.closest("svg")).toBe(svg);
        }
      }
      for (const edge of document.querySelectorAll("[marker-end]")) {
        const reference = edge.getAttribute("marker-end")?.match(/^url\(#([^)]+)\)$/);
        expect(reference).not.toBeNull();
        expect(document.getElementById(reference![1])?.closest("svg")).toBe(
          edge.closest("svg"),
        );
      }
    } finally {
      dom.window.close();
    }

    expect(returnedHeadings).toEqual([
      { id: "flow-diagram-title-1", level: 1, text: "Flow Diagram Title 1" },
      { id: "flow-arrow", level: 1, text: "Flow Arrow" },
      { id: "flow-diagram-title-2", level: 1, text: "Flow Diagram Title 2" },
    ]);
    expect(verifyArtifactHtml(readFileSync(outputPath, "utf8"))).toMatchObject({
      ok: true,
      contractVersion: 2,
    });
  });

  it("uses one rendered heading contract for rich, nested, and setext Markdown", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "canonical-headings.md");
    const outputPath = join(root, "canonical-headings.html");
    writeFileSync(
      inputPath,
      [
        "---",
        "title: Canonical headings",
        "---",
        "",
        "# [Linked](https://example.com) &amp; Entity",
        "",
        "Repeat",
        "======",
        "",
        "Repeat",
        "======",
        "",
        "> # Quote",
        "",
        "> # Quote",
        "",
        "## ![Diagram][asset] Overview",
        "",
        "[asset]: missing.png",
        "",
        "~~~",
        "# Ghost",
        "~~~",
      ].join("\n"),
    );
    let articleHtml = "";
    let headings: ThemeRenderInput["content"]["headings"] = [];

    await buildNote({
      inputPath,
      outputPath,
      theme: safeTheme((input) => {
        articleHtml = input.content.articleHtml ?? "";
        headings = input.content.headings ?? [];
        return {
          lang: input.metadata.lang,
          styles: "",
          bodyHtml: `<main>${articleHtml}</main>`,
        };
      }),
    });

    expect(headings).toEqual([
      { id: "linked-entity", level: 1, text: "Linked & Entity" },
      { id: "repeat", level: 1, text: "Repeat" },
      { id: "repeat-2", level: 1, text: "Repeat" },
      { id: "quote", level: 1, text: "Quote" },
      { id: "quote-2", level: 1, text: "Quote" },
      { id: "diagram-overview", level: 2, text: "Diagram Overview" },
    ]);
    const dom = new JSDOM(articleHtml);
    try {
      const rendered = [...dom.window.document.querySelectorAll("h1[id],h2[id]")].map(
        (heading) => ({ id: heading.id, text: heading.textContent }),
      );
      expect(rendered).toEqual(headings.map(({ id, text }) => ({ id, text })));
      expect(new Set(rendered.map(({ id }) => id)).size).toBe(rendered.length);
      expect(articleHtml).toContain("<pre><code># Ghost");
    } finally {
      dom.window.close();
    }
  });

  it("caches local image encoding while charging every embedded reference", () => {
    const bytes = Buffer.from([0x01, 0x02, 0x03]);
    let stats = 0;
    let reads = 0;
    const options = {
      sourceDirectory: "/virtual/note",
      imageIo: {
        stat(path: string) {
          stats += 1;
          expect(path).toBe("/virtual/note/pixel.png");
          return { isFile: () => true, size: bytes.length };
        },
        readFile(path: string) {
          reads += 1;
          expect(path).toBe("/virtual/note/pixel.png");
          return bytes;
        },
      },
      resourceLimits: {
        ...ARTIFACT_RESOURCE_LIMITS,
        artifactBytes: 52,
      },
    };

    const rendered = renderMarkdown(
      "![first](pixel.png)\n\n![second](pixel.png)",
      options,
    );

    expect(stats).toBe(1);
    expect(reads).toBe(1);
    expect(rendered.articleHtml.match(/data:image\/png;base64,AQID/g)).toHaveLength(2);
    expect(() =>
      renderMarkdown(
        "![first](pixel.png)\n\n![second](pixel.png)",
        {
          ...options,
          resourceLimits: {
            ...ARTIFACT_RESOURCE_LIMITS,
            artifactBytes: 51,
          },
        },
      )
    ).toThrowError(expect.objectContaining({
      name: "ArtifactBuildError",
      code: "RESOURCE_LIMIT_EXCEEDED",
    }));
  });

  it("rejects an excessive Markdown AST before rendering it", () => {
    expect(() =>
      renderMarkdown("# Heading\n\nBody", {
        sourceDirectory: "/virtual/note",
        resourceLimits: {
          ...ARTIFACT_RESOURCE_LIMITS,
          canonicalJsonNodes: 4,
        },
      })
    ).toThrowError(expect.objectContaining({
      name: "ArtifactBuildError",
      code: "RESOURCE_LIMIT_EXCEEDED",
    }));
  });

  it.each([
    ["unsafe", (input: any) => ({ lang: input.metadata.lang, styles: "", bodyHtml: "<script>bad()</script>" }), "UNSAFE_THEME_OUTPUT"],
    ["throwing", () => { throw new Error("THEME_SECRET"); }, "THEME_RENDER_FAILED"],
  ])("leaves no output after an %s theme", async (_label, render, code) => {
    const root = temporaryRoot();
    const inputPath = join(root, "note.md");
    const outputPath = join(root, "note.html");
    writeFileSync(inputPath, "# Note");

    await expectError(
      () => buildNote({ inputPath, outputPath, theme: safeTheme(render) }),
      code,
    );
    expect(existsSync(outputPath)).toBe(false);
    expect(readdirSync(root).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("preserves an existing output without force and across forced render failure", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "note.md");
    const outputPath = join(root, "note.html");
    writeFileSync(inputPath, "# Note");
    writeFileSync(outputPath, "KEEP");
    let calls = 0;

    await expectError(
      () => buildNote({
        inputPath,
        outputPath,
        theme: safeTheme(() => {
          calls += 1;
          return { lang: "en", styles: "", bodyHtml: "<main>Unused</main>" };
        }),
      }),
      "OUTPUT_EXISTS",
    );
    expect(calls).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toBe("KEEP");

    await expectError(
      () => buildNote({
        inputPath,
        outputPath,
        force: true,
        theme: safeTheme(() => { throw new Error("fail"); }),
      }),
      "THEME_RENDER_FAILED",
    );
    expect(readFileSync(outputPath, "utf8")).toBe("KEEP");
  });

  it("rolls back an atomic replacement failure and cleans only its temporary file", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "note.md");
    const outputPath = join(root, "destination");
    const unrelated = join(root, ".destination.tmp-keep");
    writeFileSync(inputPath, "# Note");
    mkdirSync(outputPath);
    writeFileSync(unrelated, "KEEP");

    await expectError(
      () => buildNote({ inputPath, outputPath, force: true, theme: safeTheme() }),
      "ATOMIC_WRITE_FAILED",
    );
    expect(readFileSync(unrelated, "utf8")).toBe("KEEP");
    expect(readdirSync(root).filter((name) =>
      name.includes(".destination.tmp-") && name !== ".destination.tmp-keep"
    )).toEqual([]);
  });

  it("rejects lexical and inode input/output aliases even with force", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "note.md");
    const aliasPath = join(root, "alias.html");
    writeFileSync(inputPath, "# Keep source");

    await expectError(
      () => buildNote({ inputPath, outputPath: inputPath, force: true, theme: safeTheme() }),
      "INVALID_BUILD_OPTIONS",
    );
    linkSync(inputPath, aliasPath);
    await expectError(
      () => buildNote({ inputPath, outputPath: aliasPath, force: true, theme: safeTheme() }),
      "INVALID_BUILD_OPTIONS",
    );
    expect(readFileSync(inputPath, "utf8")).toBe("# Keep source");
  });

  it("rejects invalid UTF-8 and oversized Markdown before writing", async () => {
    const root = temporaryRoot();
    const invalidPath = join(root, "invalid.md");
    const oversizedPath = join(root, "oversized.md");
    const outputPath = join(root, "note.html");
    writeFileSync(invalidPath, Buffer.from([0xc3, 0x28]));
    writeFileSync(oversizedPath, "x");
    truncateSync(oversizedPath, ARTIFACT_RESOURCE_LIMITS.artifactBytes + 1);

    await expectError(
      () => buildNote({ inputPath: invalidPath, outputPath, theme: safeTheme() }),
      "ARTIFACT_READ_FAILED",
    );
    await expectError(
      () => buildNote({ inputPath: oversizedPath, outputPath, theme: safeTheme() }),
      "ARTIFACT_READ_FAILED",
    );
    expect(existsSync(outputPath)).toBe(false);
  });

  it("reports malformed frontmatter without leaking its source", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "frontmatter.md");
    const outputPath = join(root, "frontmatter.html");
    writeFileSync(inputPath, "---\ntitle: PRIVATE_FRONTMATTER\n# Missing close");

    const error = await expectError(
      () => buildNote({ inputPath, outputPath, theme: safeTheme() }),
      "INVALID_MARKDOWN",
    );

    expect(error.details).toEqual({ section: "frontmatter" });
    expect(JSON.stringify(error.toJSON())).not.toContain("PRIVATE_FRONTMATTER");
    expect(error.cause).toBeUndefined();
    expect(existsSync(outputPath)).toBe(false);
  });

  it("reports an invalid flow by safe line number without source leakage", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "flow.md");
    const outputPath = join(root, "flow.html");
    writeFileSync(
      inputPath,
      "# Flow\n\n```flow\nflowchart LR\nPRIVATE_FLOW_SOURCE\n```",
    );

    const error = await expectError(
      () => buildNote({ inputPath, outputPath, theme: safeTheme() }),
      "INVALID_FLOW_DIAGRAM",
    );

    expect(error.details).toEqual({ line: 2 });
    expect(JSON.stringify(error.toJSON())).not.toContain("PRIVATE_FLOW_SOURCE");
    expect(error.cause).toBeUndefined();
    expect(existsSync(outputPath)).toBe(false);
  });

  it("reports malformed image path encoding with sanitized details", async () => {
    const root = temporaryRoot();
    const inputPath = join(root, "image-uri.md");
    const outputPath = join(root, "image-uri.html");
    writeFileSync(inputPath, "# Image\n\n![private](PRIVATE_%ZZ.png)");

    const error = await expectError(
      () => buildNote({ inputPath, outputPath, theme: safeTheme() }),
      "INVALID_IMAGE_SOURCE",
    );

    expect(error.details).toEqual({ operation: "decode" });
    expect(JSON.stringify(error.toJSON())).not.toContain("PRIVATE_");
    expect(error.cause).toBeUndefined();
    expect(existsSync(outputPath)).toBe(false);
  });

  it("sanitizes a local image read race after successful stat", () => {
    let caught: unknown;
    try {
      renderMarkdown("![private](race.png)", {
        sourceDirectory: "/PRIVATE_DIRECTORY",
        imageIo: {
          stat() {
            return { isFile: () => true, size: 3 };
          },
          readFile() {
            throw new Error("PRIVATE_DIRECTORY/race.png disappeared");
          },
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ArtifactBuildError);
    expect(caught).toMatchObject({
      code: "IMAGE_READ_FAILED",
      details: { operation: "read" },
    });
    expect((caught as Error).cause).toBeUndefined();
    expect(JSON.stringify((caught as ArtifactBuildError).toJSON())).not.toContain(
      "PRIVATE_",
    );
  });

  it("keeps core note building free of shell, CSS, site, and theme fallback ownership", () => {
    const buildSource = readFileSync(new URL("../src/build-note.mjs", import.meta.url), "utf8");
    const renderSource = readFileSync(new URL("../src/render-markdown.mjs", import.meta.url), "utf8");
    const source = `${buildSource}\n${renderSource}`;

    expect(source).not.toMatch(/node:child_process|spawn|execFile|execSync/);
    expect(source).not.toMatch(/\.css["']|theme-402v|@402v\/theme|site\/|public\//);
    expect(source).not.toMatch(/import\s*\(/);
  });

  it("reuses the assembly verification result instead of parsing the document twice", () => {
    const buildSource = readFileSync(
      new URL("../src/build-note.mjs", import.meta.url),
      "utf8",
    );
    const assemblySource = readFileSync(
      new URL("../src/document-v2.mjs", import.meta.url),
      "utf8",
    );

    expect(buildSource).toContain("assembleArtifactV2WithVerification");
    expect(buildSource).not.toContain("verifyArtifactHtml");
    expect(assemblySource.match(/verifyArtifactHtml\(/g)).toHaveLength(1);
  });
});
