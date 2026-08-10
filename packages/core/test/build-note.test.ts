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

  it("keeps core note building free of shell, CSS, site, and theme fallback ownership", () => {
    const buildSource = readFileSync(new URL("../src/build-note.mjs", import.meta.url), "utf8");
    const renderSource = readFileSync(new URL("../src/render-markdown.mjs", import.meta.url), "utf8");
    const source = `${buildSource}\n${renderSource}`;

    expect(source).not.toMatch(/node:child_process|spawn|execFile|execSync/);
    expect(source).not.toMatch(/\.css["']|theme-402v|@402v\/theme|site\/|public\//);
    expect(source).not.toMatch(/import\s*\(/);
  });
});
