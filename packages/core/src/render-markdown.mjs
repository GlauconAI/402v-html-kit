import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

import { renderFlowDiagram } from "./flow.mjs";

const IMAGE_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);

export function renderMarkdown(body, { sourceDirectory }) {
  const headings = extractHeadings(body);
  const headingIds = [...headings];
  const allocateId = createIdAllocator(headings.map((heading) => heading.id));
  let flowIndex = 0;
  const components = {
    h1: headingComponent("h1", headingIds),
    h2: headingComponent("h2", headingIds),
    h3: headingComponent("h3", headingIds),
    blockquote({ children }) {
      const match = textContent(children)
        .trimStart()
        .match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
      if (!match) return React.createElement("blockquote", null, children);

      const type = match[1].toLowerCase();
      return React.createElement(
        "blockquote",
        {
          className: `callout callout-${type}`,
          "data-callout-label": match[1].toUpperCase(),
        },
        stripFirstText(children, /^\s*\[![A-Z]+\]\s*/i),
      );
    },
    pre({ children }) {
      const child = Array.isArray(children) ? children[0] : children;
      if (React.isValidElement(child)) {
        const className = child.props.className || "";
        if (/\blanguage-(?:mermaid|flow)\b/.test(className)) {
          const source = String(child.props.children || "").replace(/\n$/, "");
          flowIndex += 1;
          const titleId = allocateId(`flow-diagram-title-${flowIndex}`);
          const markerId = allocateId("flow-arrow");
          return React.createElement("div", {
            className: "flow-embed",
            dangerouslySetInnerHTML: {
              __html: renderFlowDiagram(source, { markerId, titleId }),
            },
          });
        }
      }
      return React.createElement("pre", null, children);
    },
    code({ className, children }) {
      return React.createElement("code", { className }, children);
    },
    img({ alt, src, title }) {
      const image = resolveImage(src, sourceDirectory);
      if (image.kind === "passive") {
        return React.createElement(
          "a",
          {
            href: image.href,
            title,
            "data-image-fallback": "",
          },
          alt || title || image.href,
        );
      }
      return React.createElement("img", {
        alt: alt || "",
        src: image.src,
        title,
        loading: "lazy",
      });
    },
    a({ href, children }) {
      const external = /^https?:\/\//i.test(href || "");
      return React.createElement(
        "a",
        {
          href,
          ...(external
            ? { target: "_blank", rel: "noreferrer noopener" }
            : {}),
        },
        children,
      );
    },
  };

  const articleHtml = renderToStaticMarkup(
    React.createElement(
      Markdown,
      { remarkPlugins: [remarkGfm], components },
      body,
    ),
  );

  return { articleHtml, headings };
}

function createIdAllocator(reservedIds) {
  const used = new Set(reservedIds);
  return function allocateId(base) {
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  };
}

function headingComponent(tagName, headingIds) {
  return function Heading({ children }) {
    const text = textContent(children);
    const nextIndex = headingIds.findIndex(
      (heading) => heading.level === Number(tagName.slice(1)) &&
        heading.text === text,
    );
    const heading =
      nextIndex >= 0
        ? headingIds.splice(nextIndex, 1)[0]
        : { id: slugify(text) };
    return React.createElement(tagName, { id: heading.id }, children);
  };
}

function extractHeadings(markdown) {
  const seen = new Map();
  const headings = [];
  let insideFence = false;

  for (const line of markdown.split("\n")) {
    if (/^```/.test(line.trim())) {
      insideFence = !insideFence;
      continue;
    }
    if (insideFence) continue;

    const match = line.match(/^(#{1,3})\s+(.+?)\s*#*\s*$/);
    if (!match) continue;
    const level = match[1].length;
    const text = match[2].replace(/[*_`[\]]/g, "").trim();
    const base = slugify(text);
    const count = seen.get(base) || 0;
    seen.set(base, count + 1);
    headings.push({
      level,
      text,
      id: count === 0 ? base : `${base}-${count + 1}`,
    });
  }

  return headings;
}

function resolveImage(src, sourceDirectory) {
  if (!src) throw new Error("Image source is empty or unsafe");
  if (/^data:image\//i.test(src)) return { kind: "embedded", src };
  if (/^https?:\/\//i.test(src) || src.startsWith("#")) {
    return { kind: "passive", href: src };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src) || src.startsWith("//")) {
    throw new Error("Unsupported image URL scheme");
  }
  const decoded = decodeURIComponent(src);
  const path = isAbsolute(decoded)
    ? decoded
    : resolve(sourceDirectory, decoded);

  if (!existsSync(path) || !statSync(path).isFile()) {
    return { kind: "passive", href: src };
  }

  const extension = extname(path).toLowerCase();
  const mime = IMAGE_MIME_TYPES.get(extension);
  if (!mime) {
    throw new Error(`Unsupported local image type: ${extension || "unknown"}`);
  }

  const bytes = readFileSync(path);
  if (bytes.length > 10 * 1024 * 1024) {
    throw new Error(`Local image exceeds 10 MB: ${decoded}`);
  }
  return {
    kind: "embedded",
    src: `data:${mime};base64,${bytes.toString("base64")}`,
  };
}

function slugify(value) {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\u3400-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "section";
}

function textContent(value) {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) return value.map(textContent).join("");
  if (React.isValidElement(value)) return textContent(value.props.children);
  return "";
}

function stripFirstText(value, pattern, state = { done: false }) {
  if (typeof value === "string") {
    if (state.done) return value;
    const replaced = value.replace(pattern, "");
    if (replaced !== value) state.done = true;
    return replaced;
  }
  if (Array.isArray(value)) {
    return value.map((item) => stripFirstText(item, pattern, state));
  }
  if (React.isValidElement(value)) {
    return React.cloneElement(
      value,
      value.props,
      stripFirstText(value.props.children, pattern, state),
    );
  }
  return value;
}
