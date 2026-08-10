import { ArtifactBuildError } from "./errors.mjs";

const ALLOWED_FIELDS = new Set(["title", "description", "eyebrow", "lang"]);

function fail(message, details) {
  throw new ArtifactBuildError("INVALID_MARKDOWN", message, details);
}

export function parseMarkdownDocument(source) {
  if (typeof source !== "string" || !source.trim()) {
    fail("Markdown input is empty", { section: "document" });
  }

  const normalized = source.replace(/\r\n?/g, "\n");
  const metadata = {};
  let body = normalized;

  if (normalized.startsWith("---\n")) {
    const closingIndex = normalized.indexOf("\n---\n", 4);
    if (closingIndex === -1) {
      fail("Markdown frontmatter is not closed", { section: "frontmatter" });
    }

    const frontmatter = normalized.slice(4, closingIndex);
    body = normalized.slice(closingIndex + 5);

    for (const line of frontmatter.split("\n")) {
      if (!line.trim()) continue;
      const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
      if (!match) {
        fail("Markdown frontmatter contains an invalid field", {
          section: "frontmatter",
        });
      }

      const [, key, rawValue] = match;
      if (!ALLOWED_FIELDS.has(key)) continue;
      metadata[key] = unquote(rawValue.trim());
    }
  }

  return {
    body: body.trim(),
    metadata: {
      title: metadata.title || "",
      description: metadata.description || "",
      eyebrow: metadata.eyebrow || "402v Knowledge",
      lang: metadata.lang || "zh-CN",
    },
  };
}

function unquote(value) {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}
