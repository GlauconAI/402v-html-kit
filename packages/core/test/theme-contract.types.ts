import type {
  ThemeRenderInput,
  ThemeRenderResult,
} from "../src/index.mjs";

function assertReadonlyContract(
  input: ThemeRenderInput,
  result: ThemeRenderResult,
) {
  // @ts-expect-error runtime freezes the top-level input.
  input.mode = "note";
  // @ts-expect-error runtime freezes the metadata reference.
  input.metadata = { title: "", description: "", eyebrow: "", lang: "en" };
  // @ts-expect-error runtime freezes nested metadata.
  input.metadata.title = "Changed";
  // @ts-expect-error runtime freezes the content reference.
  input.content = {};
  // @ts-expect-error runtime freezes optional content fields.
  input.content.articleHtml = "Changed";

  const headings = input.content.headings;
  if (headings !== undefined) {
    // @ts-expect-error frozen heading arrays cannot be sorted in place.
    headings.sort((left, right) => left.level - right.level);
    const heading = headings[0];
    if (heading !== undefined) {
      // @ts-expect-error runtime freezes every heading.
      heading.text = "Changed";
    }
  }

  const slots = input.content.slots;
  if (slots !== undefined) {
    // @ts-expect-error runtime freezes optional slots.
    slots.navigation = "Changed";
  }

  const svg = input.content.svg;
  if (svg !== undefined) {
    // @ts-expect-error runtime freezes the prepared SVG record.
    svg.logo = { id: "logo", label: "logo.svg", html: "<svg></svg>" };
    const prepared = svg.logo;
    if (prepared !== undefined) {
      // @ts-expect-error runtime freezes every prepared SVG.
      prepared.html = "<svg>Changed</svg>";
    }
  }

  // @ts-expect-error renderThemeV1 freezes returned result fields.
  result.lang = "fr";
  // @ts-expect-error renderThemeV1 freezes returned result fields.
  result.bodyHtml = "<main>Changed</main>";
}

void assertReadonlyContract;
