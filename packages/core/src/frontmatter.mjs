const ALLOWED_FIELDS = new Set(["title", "description", "eyebrow", "lang"]);

export function parseMarkdownDocument(source) {
  if (typeof source !== "string" || !source.trim()) {
    throw new Error("Markdown input is empty");
  }

  const normalized = source.replace(/\r\n?/g, "\n");
  const metadata = {};
  let body = normalized;

  if (normalized.startsWith("---\n")) {
    const closingIndex = normalized.indexOf("\n---\n", 4);
    if (closingIndex === -1) {
      throw new Error("Frontmatter is missing its closing --- line");
    }

    const frontmatter = normalized.slice(4, closingIndex);
    body = normalized.slice(closingIndex + 5);

    for (const line of frontmatter.split("\n")) {
      if (!line.trim()) continue;
      const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*):\s*(.*)$/);
      if (!match) {
        throw new Error(`Invalid frontmatter line: ${line}`);
      }

      const [, key, rawValue] = match;
      if (!ALLOWED_FIELDS.has(key)) continue;
      metadata[key] = unquote(rawValue.trim());
    }
  }

  const headingTitle = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const title = metadata.title || headingTitle || "Untitled Note";

  return {
    body: body.trim(),
    metadata: {
      title,
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
