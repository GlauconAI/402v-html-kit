import { describe, expect, it } from "vitest";

import { renderThemeV1 } from "../../core/src/index.mjs";
import theme402vDefault, { theme402v } from "../src/index.mjs";

const metadata = {
  title: "The <Official> & 402v Theme",
  description: "A standalone, offline artifact",
  eyebrow: "Reference & release",
  lang: "en",
};

const preparedSvg = {
  mark: {
    id: "mark",
    label: "mark.svg",
    html: '<div class="artifact-svg-frame"><svg class="artifact-svg" viewBox="0 0 1200 240" role="img" aria-labelledby="mark-title"><title id="mark-title">402v mark</title><rect width="1200" height="240"/></svg></div>',
    byteLength: 230,
  },
};

function noteInput(lang = "en") {
  return {
    mode: "note" as const,
    metadata: { ...metadata, lang },
    content: {
      articleHtml:
        '<article data-source="note"><h1>Source title</h1><h2 id="details">Details</h2><p>Note article body.</p></article>',
      headings: [
        { id: "details", level: 2, text: "Details & usage" },
        { id: "deep-dive", level: 3, text: "Deep dive" },
        { id: "not-in-toc", level: 4, text: "Implementation detail" },
      ],
    },
  };
}

function interactiveInput() {
  return {
    mode: "interactive" as const,
    metadata,
    content: {
      slots: {
        navigation: '<nav aria-label="Demo"><a href="#chart">Chart</a></nav>',
        heroSupplementary: '<p data-slot="hero">Live but offline</p>',
        mainSections: `<section id="chart" data-slot="main"><h2>Chart</h2>${preparedSvg.mark.html}</section>`,
        rail: '<section data-slot="rail">Legend</section>',
        footer: '<span data-slot="footer">Custom footer · </span>',
      },
      svg: preparedSvg,
    },
  };
}

describe("the official 402v theme", () => {
  it("exports one frozen Theme Contract v1 identity", () => {
    expect(theme402vDefault).toBe(theme402v);
    expect(theme402v).toMatchObject({
      themeContractVersion: 1,
      id: "402v",
      version: "0.1.0",
      displayName: "402v",
    });
    expect(Reflect.ownKeys(theme402v)).toEqual([
      "themeContractVersion",
      "id",
      "version",
      "displayName",
      "render",
    ]);
    expect(Object.isFrozen(theme402v)).toBe(true);
  });

  it("renders note article, headings, 402v labels, and escaped title presentation", () => {
    const result = theme402v.render(noteInput());

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.lang).toBe("en");
    expect(result.bodyHtml).toContain('<a class="artifact-brand" href="https://402v.com">402v</a>');
    expect(result.bodyHtml).toContain("The &lt;Official&gt; &amp; 402v Theme");
    expect(result.bodyHtml).toContain('<article class="note-article">');
    expect(result.bodyHtml).toContain('data-source="note"');
    expect(result.bodyHtml).toContain('<a href="#details">Details &amp; usage</a>');
    expect(result.bodyHtml).toContain('<a href="#deep-dive">Deep dive</a>');
    expect(result.bodyHtml).not.toContain("Implementation detail");
    expect(result.bodyHtml).toContain("layout</dt><dd>402v / note");
    expect(result.bodyHtml).toContain("402v HTML Note Kit · standalone HTML");
  });

  it("renders interactive slots and prepared SVG exactly once", () => {
    const result = theme402v.render(interactiveInput());

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.bodyHtml).toContain('class="artifact-navigation-slot"');
    expect(result.bodyHtml).toContain('data-slot="hero"');
    expect(result.bodyHtml).toContain('data-slot="main"');
    expect(result.bodyHtml).toContain('data-slot="rail"');
    expect(result.bodyHtml).toContain('data-slot="footer"');
    expect(result.bodyHtml).toContain("layout</dt><dd>402v / interactive");
    expect(result.bodyHtml.match(/<svg\b/g)).toHaveLength(1);
  });

  it("uses en as the direct-render language fallback", () => {
    expect(theme402v.render(noteInput("")).lang).toBe("en");
  });

  it("keeps presentation responsive and printable", () => {
    const noteStyles = theme402v.render(noteInput()).styles;
    const interactiveStyles = theme402v.render(interactiveInput()).styles;

    expect(noteStyles).toContain("@media (max-width: 900px)");
    expect(noteStyles).toContain("@media (max-width: 640px)");
    expect(noteStyles).toContain("@media print");
    expect(interactiveStyles).toContain(".artifact-svg-frame");
    expect(interactiveStyles).toContain("overflow-x: auto");
  });

  it.each([
    ["note", noteInput()],
    ["interactive", interactiveInput()],
  ])("passes core output safety for %s without taking core ownership", (_mode, input) => {
    const result = renderThemeV1(theme402v, input);

    expect(Object.isFrozen(result)).toBe(true);
    expect(result.bodyHtml).not.toMatch(
      /<!doctype|<(?:html|head|body|meta|link|style|script)\b|data-html-kit-(?:root|runtime|consumer-script)|type=["']application\/json/i,
    );
    expect(result.styles).not.toMatch(/@import|url\s*\(/i);
  });
});
