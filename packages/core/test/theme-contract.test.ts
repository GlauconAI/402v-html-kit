import { describe, expect, it } from "vitest";
import {
  ARTIFACT_RESOURCE_LIMITS,
  ArtifactBuildError,
  renderThemeV1 as typedRenderThemeV1,
} from "../src/index.mjs";
import type { ThemeRenderResult } from "../src/index.mjs";

const renderThemeV1 = typedRenderThemeV1 as unknown as (
  theme: unknown,
  input: unknown,
) => ThemeRenderResult;
const themeResourceLimits = ARTIFACT_RESOURCE_LIMITS as typeof ARTIFACT_RESOURCE_LIMITS & {
  slotBytes: number;
  slotAggregateBytes: number;
};

const metadata = {
  title: "Theme contract",
  description: "Trusted local theme",
  eyebrow: "Test",
  lang: "en",
};

const safeResult = {
  lang: "en",
  styles: ":root{color-scheme:light}",
  bodyHtml: '<main class="page"><a href="#details">Details</a></main>',
};

function theme(render: (input: unknown) => unknown = () => safeResult) {
  return {
    themeContractVersion: 1,
    id: "example-theme",
    version: "1.0.0",
    displayName: "Example Theme",
    render,
  };
}

function input() {
  return {
    mode: "interactive",
    metadata,
    content: {
      articleHtml: "<article>Source</article>",
      headings: [{ id: "source", level: 2, text: "Source" }],
      slots: { navigation: '<a href="#source">Source</a>' },
      svg: {
        mark: {
          id: "mark",
          label: "mark.svg",
          html: '<div class="artifact-svg-frame"><svg viewBox="0 0 1 1"><title>Mark</title><circle cx=".5" cy=".5" r=".5"/></svg></div>',
          byteLength: 128,
        },
      },
    },
  };
}

function expectCode(callback: () => unknown, code: string) {
  let caught: unknown;
  try {
    callback();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(ArtifactBuildError);
  expect((caught as ArtifactBuildError).code).toBe(code);
  return caught as ArtifactBuildError;
}

describe("Theme Contract v1", () => {
  it("passes a deeply frozen defensive input and accepts inert presentation", () => {
    const source = input();
    let received: unknown;
    const result = renderThemeV1(
      theme((themeInput) => {
        received = themeInput;
        expect(Object.isFrozen(themeInput)).toBe(true);
        const inspected = themeInput as ReturnType<typeof input>;
        expect(Object.isFrozen(inspected.metadata)).toBe(true);
        expect(Object.isFrozen(inspected.content)).toBe(true);
        expect(Object.isFrozen(inspected.content.headings)).toBe(true);
        expect(Object.isFrozen(inspected.content.headings[0])).toBe(true);
        expect(Object.isFrozen(inspected.content.slots)).toBe(true);
        expect(Object.isFrozen(inspected.content.svg)).toBe(true);
        expect(Object.isFrozen(inspected.content.svg.mark)).toBe(true);
        return safeResult;
      }),
      source,
    );

    expect(received).not.toBe(source);
    expect((received as ReturnType<typeof input>).metadata).not.toBe(source.metadata);
    expect((received as ReturnType<typeof input>).content).not.toBe(source.content);
    expect(result).toEqual(safeResult);
  });

  it.each([
    ["script", "<script>window.pwned=true</script>"],
    ["core contract meta", '<meta name="html-kit-artifact-contract" content="2">'],
    ["application/json shadow block", '<script type="application/json" id="shadow">{}</script>'],
    ["external img", '<img src="https://example.invalid/pixel.png">'],
    ["doctype ownership", "<!doctype html><main>Owned</main>"],
    ["document ownership", "<html><head><title>Owned</title></head><body>Owned</body></html>"],
  ])("rejects %s body output", (_label, bodyHtml) => {
    expectCode(
      () => renderThemeV1(theme(() => ({ ...safeResult, bodyHtml })), input()),
      "UNSAFE_THEME_OUTPUT",
    );
  });

  it("inspects theme descriptors without invoking getters", () => {
    let getterCalls = 0;
    const candidate = theme();
    Object.defineProperty(candidate, "render", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return () => safeResult;
      },
    });

    expectCode(() => renderThemeV1(candidate, input()), "INVALID_THEME");
    expect(getterCalls).toBe(0);
  });

  it.each([
    ["wrong contract", { ...theme(), themeContractVersion: 2 }],
    ["missing render", (({ render: _render, ...rest }) => rest)(theme())],
    ["non-callable render", { ...theme(), render: "render" }],
    ["extra shape fields", { ...theme(), renderer: () => safeResult, extra: true }],
    ["empty id", { ...theme(), id: " " }],
    ["unbounded id", { ...theme(), id: "a".repeat(129) }],
    ["empty version", { ...theme(), version: "" }],
    ["unbounded version", { ...theme(), version: `1.0.0-${"a".repeat(129)}` }],
    ["empty displayName", { ...theme(), displayName: "\t" }],
    ["unbounded displayName", { ...theme(), displayName: "a".repeat(257) }],
    ["non-plain theme", Object.assign(new (class Theme {})(), theme())],
    ["symbol-key theme", Object.assign(theme(), { [Symbol("unsafe")]: true })],
  ])("rejects %s", (_label, candidate) => {
    expectCode(() => renderThemeV1(candidate, input()), "INVALID_THEME");
  });

  it("deep-clones input, freezes every nested value, and blocks caller mutation", () => {
    const source = input();
    const originalTitle = source.metadata.title;
    const originalHeading = source.content.headings[0].text;
    let received: ReturnType<typeof input> | undefined;

    renderThemeV1(
      theme((value) => {
        received = value as ReturnType<typeof input>;
        expect(Reflect.set(received.metadata, "title", "mutated")).toBe(false);
        expect(Reflect.set(received.content.headings[0], "text", "mutated")).toBe(false);
        expect(Reflect.set(received.content.slots, "navigation", "mutated")).toBe(false);
        expect(Reflect.set(received.content.svg.mark, "html", "mutated")).toBe(false);
        return safeResult;
      }),
      source,
    );

    expect(received).toBeDefined();
    expect(received!.content.headings).not.toBe(source.content.headings);
    expect(received!.content.headings[0]).not.toBe(source.content.headings[0]);
    expect(received!.content.slots).not.toBe(source.content.slots);
    expect(received!.content.svg.mark).not.toBe(source.content.svg.mark);
    expect(source.metadata.title).toBe(originalTitle);
    expect(source.content.headings[0].text).toBe(originalHeading);
  });

  it("rejects unsafe render input without invoking getters or the theme", () => {
    let getterCalls = 0;
    let renderCalls = 0;
    const source = input();
    Object.defineProperty(source.content, "articleHtml", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "secret";
      },
    });

    expectCode(
      () => renderThemeV1(theme(() => { renderCalls += 1; return safeResult; }), source),
      "INVALID_THEME_INPUT",
    );
    expect(getterCalls).toBe(0);
    expect(renderCalls).toBe(0);
  });

  it.each([
    ["cycle", () => {
      const source = input() as ReturnType<typeof input> & { self?: unknown };
      source.self = source;
      return source;
    }],
    ["symbol key", () => Object.assign(input(), { [Symbol("unsafe")]: true })],
    ["function value", () => Object.assign(input(), { unsafe: () => true })],
    ["unsupported prototype", () => Object.assign(new (class Input {})(), input())],
    ["sparse array", () => {
      const source = input();
      source.content.headings = new Array(1) as typeof source.content.headings;
      return source;
    }],
    ["non-finite number", () => {
      const source = input();
      source.content.headings[0].level = Number.POSITIVE_INFINITY;
      return source;
    }],
  ])("rejects input containing %s", (_label, buildInput) => {
    expectCode(
      () => renderThemeV1(theme(), buildInput()),
      "INVALID_THEME_INPUT",
    );
  });

  it.each([
    ["Error", () => { throw new Error("THROWN_SECRET"); }],
    ["non-Error", () => { throw { secret: "NON_ERROR_SECRET" }; }],
  ])("redacts %s values thrown by themes", (_label, render) => {
    const source = input();
    source.metadata.title = "SOURCE_INPUT_SECRET";
    const error = expectCode(
      () => renderThemeV1(theme(render), source),
      "THEME_RENDER_FAILED",
    );
    const publicFailure = `${error.message}\n${JSON.stringify(error.details)}`;
    expect(publicFailure).not.toContain("THROWN_SECRET");
    expect(publicFailure).not.toContain("NON_ERROR_SECRET");
    expect(publicFailure).not.toContain("SOURCE_INPUT_SECRET");
  });

  it("inspects returned descriptors without invoking getters", () => {
    let getterCalls = 0;
    const returned = { styles: "", bodyHtml: "<main>Safe</main>" } as {
      lang?: string;
      styles: string;
      bodyHtml: string;
    };
    Object.defineProperty(returned, "lang", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "en";
      },
    });

    expectCode(
      () => renderThemeV1(theme(() => returned), input()),
      "INVALID_THEME_OUTPUT",
    );
    expect(getterCalls).toBe(0);
  });

  it.each([
    ["null", null],
    ["array", ["en", "", "<main>Safe</main>"]],
    ["non-plain object", Object.assign(new (class Result {})(), safeResult)],
    ["extra field", { ...safeResult, scripts: [] }],
    ["missing field", { lang: "en", styles: "" }],
    ["non-string lang", { ...safeResult, lang: 1 }],
    ["non-string styles", { ...safeResult, styles: null }],
    ["non-string body", { ...safeResult, bodyHtml: new String("safe") }],
    ["symbol key", Object.assign({ ...safeResult }, { [Symbol("unsafe")]: true })],
  ])("rejects returned result with %s", (_label, returned) => {
    expectCode(
      () => renderThemeV1(theme(() => returned), input()),
      "INVALID_THEME_OUTPUT",
    );
  });

  it.each([
    ["style element", "<style>body{display:none}</style>"],
    ["SVG style element", "<svg viewBox=\"0 0 1 1\"><style>circle{fill:red}</style><circle r=\"1\"/></svg>"],
    ["link element", '<link rel="stylesheet" href="https://example.invalid/x.css">'],
    ["base element", '<base href="https://example.invalid/">'],
    ["html event handler", '<button OnClIcK="window.pwned=true">Run</button>'],
    ["svg event handler", '<svg viewBox="0 0 1 1" oNlOaD="window.pwned=true"></svg>'],
    ["protocol root", '<main data-html-kit-root>Shadow</main>'],
    ["protocol runtime", '<main data-html-kit-runtime>Shadow</main>'],
    ["javascript URL", '<a href="javascript:window.pwned=true">Run</a>'],
    ["obfuscated URL", '<a href="java\nscript:window.pwned=true">Run</a>'],
    ["data URL", '<a href="data:text/html,active">Run</a>'],
    ["vbscript URL", '<a href="vbscript:msgbox(1)">Run</a>'],
    ["iframe resource", '<iframe src="https://example.invalid/"></iframe>'],
    ["srcset resource", '<img srcset="https://example.invalid/a.png 1x">'],
    ["poster resource", '<video poster="https://example.invalid/a.png"></video>'],
    ["object data resource", '<object data="https://example.invalid/a"></object>'],
    ["XML base resource", '<svg xml:base="https://example.invalid/remote.svg"><use href="#payload"/></svg>'],
    ["form action", '<form action="https://example.invalid/submit"></form>'],
    ["formaction", '<button formaction="/submit">Submit</button>'],
    ["ping", '<a href="#safe" ping="https://example.invalid/audit">Safe</a>'],
    ["refresh", '<meta http-equiv="refresh" content="0;url=https://example.invalid/">'],
    ["background", '<table background="https://example.invalid/a.png"></table>'],
  ])("rejects hostile body construct: %s", (_label, bodyHtml) => {
    expectCode(
      () => renderThemeV1(theme(() => ({ ...safeResult, bodyHtml })), input()),
      "UNSAFE_THEME_OUTPUT",
    );
  });

  it.each([
    ["explicit HTML body", "<body><main>x</main></body>"],
    ["SVG link", "<svg><link></link></svg>"],
    ["SVG base", "<svg><base></base></svg>"],
    ["SVG form", "<svg><form></form></svg>"],
    ["SVG html", "<svg><html></html></svg>"],
    ["SVG head", "<svg><head></head></svg>"],
    ["SVG body", "<svg><body></body></svg>"],
    ["mismatched foreign close", "<svg></math><head></head></svg>"],
    ["crossed SVG/MathML head", "<svg><math></svg></math><head></head>"],
    ["crossed SVG/MathML body", "<svg><math></svg></math><body>x</body>"],
    ["crossed SVG/MathML html", "<svg><math></svg></math><html></html>"],
    ["crossed MathML/SVG head", "<math><svg></math></svg><head></head>"],
  ])("rejects namespace-independent ownership element: %s", (_label, bodyHtml) => {
    expectCode(
      () => renderThemeV1(theme(() => ({ ...safeResult, bodyHtml })), input()),
      "UNSAFE_THEME_OUTPUT",
    );
  });

  it("allows inert fragments, inline prepared SVG, and passive safe links", () => {
    const bodyHtml = [
      '<main data-on-state="onclick is text">',
      '<a href="#section">Fragment</a>',
      '<a href="relative/page.html">Relative</a>',
      '<a href="/rooted/page.html">Rooted</a>',
      '<a href="https://example.invalid/page">HTTPS</a>',
      '<a href="http://example.invalid/page">HTTP</a>',
      '<a href="mailto:reader@example.invalid">Mail</a>',
      '<a href="tel:+15551234567">Call</a>',
      '<svg role="img" viewBox="0 0 1 1"><title>Dot</title><circle cx=".5" cy=".5" r=".5"/></svg>',
      "</main>",
    ].join("");
    expect(renderThemeV1(theme(() => ({ ...safeResult, bodyHtml })), input())).toMatchObject({ bodyHtml });
  });

  it.each([
    ['@import "https://example.invalid/theme.css";', "INVALID_STYLESHEET"],
    ['main{background:url("https://example.invalid/a.png")}', "INVALID_STYLESHEET"],
    ["</style><script>window.pwned=true</script>", "INVALID_STYLESHEET"],
  ])("uses the existing stylesheet validator for %s", (styles, code) => {
    expectCode(
      () => renderThemeV1(theme(() => ({ ...safeResult, styles })), input()),
      code,
    );
  });

  it("enforces stylesheet bytes using UTF-8 accounting", () => {
    const exact = "é".repeat(ARTIFACT_RESOURCE_LIMITS.stylesheetBytes / 2);
    expect(renderThemeV1(theme(() => ({ ...safeResult, styles: exact })), input()).styles).toBe(exact);
    expectCode(
      () => renderThemeV1(theme(() => ({ ...safeResult, styles: `${exact}a` })), input()),
      "RESOURCE_LIMIT_EXCEEDED",
    );
  });

  it("enforces per-slot and aggregate slot bytes using UTF-8 accounting", () => {
    const exactSlot = "é".repeat(themeResourceLimits.slotBytes / 2);
    const source = input();
    source.content.slots = { navigation: exactSlot };
    expect(renderThemeV1(theme(), source)).toEqual(safeResult);

    source.content.slots.navigation = `${exactSlot}a`;
    expectCode(() => renderThemeV1(theme(), source), "RESOURCE_LIMIT_EXCEEDED");

    const aggregate = input();
    Object.assign(aggregate.content.slots, {
      navigation: exactSlot,
      footer: `${exactSlot}a`,
    });
    expectCode(() => renderThemeV1(theme(), aggregate), "RESOURCE_LIMIT_EXCEEDED");
  });

  it("returns a new frozen result object", () => {
    const sourceResult = { ...safeResult };
    const result = renderThemeV1(theme(() => sourceResult), input());
    expect(result).not.toBe(sourceResult);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Reflect.set(result, "lang", "fr")).toBe(false);
    expect(sourceResult.lang).toBe("en");
  });
});
