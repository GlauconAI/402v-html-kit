import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  statSync,
} from "node:fs";
import { extname, isAbsolute, resolve } from "node:path";

import { ArtifactBuildError } from "./errors.mjs";
import { renderFlowDiagram } from "./flow.mjs";
import { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";

const IMAGE_MIME_TYPES = new Map([
  [".avif", "image/avif"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".svg", "image/svg+xml"],
  [".webp", "image/webp"],
]);
const MAX_LOCAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_HEADING_ID_BYTES = 256;
const IMAGE_READ_CHUNK_BYTES = 64 * 1024;
/**
 * @type {Readonly<{
 *   readFile(path: string, maximumBytes: number): Buffer,
 *   stat(path: string): { isFile(): boolean, size: number },
 * }>}
 */
const DEFAULT_IMAGE_IO = Object.freeze({
  readFile(path, maximumBytes) {
    return readLocalImageBounded(path, maximumBytes);
  },
  stat(path) {
    return statSync(path);
  },
});

function fail(code, message, details = undefined) {
  throw new ArtifactBuildError(code, message, details);
}

/**
 * @param {string} body
 * @param {{
 *   sourceDirectory: string,
 *   imageIo?: Partial<typeof DEFAULT_IMAGE_IO>,
 *   resourceLimits?: typeof ARTIFACT_RESOURCE_LIMITS,
 * }} options
 */
export function renderMarkdown(
  body,
  {
    sourceDirectory,
    imageIo = {},
    resourceLimits = ARTIFACT_RESOURCE_LIMITS,
  },
) {
  const headings = [];
  const imageCache = new Map();
  const selectedImageIo = {
    stat: imageIo.stat ?? DEFAULT_IMAGE_IO.stat,
    readFile: imageIo.readFile ?? DEFAULT_IMAGE_IO.readFile,
  };
  const renderBudget = { embeddedImageBytes: 0 };
  let headingIndex = 0;
  const allocateId = createIdAllocator();
  const headingComponents = Object.fromEntries(
    Array.from({ length: 6 }, (_, index) => {
      const tagName = `h${index + 1}`;
      return [
        tagName,
        function Heading({ children }) {
          const heading = headings[headingIndex];
          headingIndex += 1;
          if (heading === undefined || heading.level !== index + 1) {
            throw new Error("Markdown heading analysis diverged from rendering");
          }
          return React.createElement(tagName, { id: heading.id }, children);
        },
      ];
    }),
  );
  let flowIndex = 0;
  const components = {
    ...headingComponents,
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
              __html: renderFlowDiagram(source, {
                markerId,
                titleId,
                resourceLimits,
              }),
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
      const image = resolveImage(src, sourceDirectory, {
        cache: imageCache,
        imageIo: selectedImageIo,
        renderBudget,
        resourceLimits,
      });
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
      {
        remarkPlugins: [
          remarkGfm,
          createMarkdownAnalysisPlugin(headings, resourceLimits, allocateId),
        ],
        components,
      },
      body,
    ),
  );

  return { articleHtml, headings };
}

function readLocalImageBounded(path, maximumBytes) {
  let descriptor;
  try {
    descriptor = openSync(path, "r");
    const before = fstatSync(descriptor);
    if (!before.isFile()) {
      fail("IMAGE_READ_FAILED", "Local Markdown image changed before reading", {
        operation: "read",
      });
    }
    if (
      !Number.isSafeInteger(before.size) ||
      before.size < 0 ||
      before.size > maximumBytes
    ) {
      fail(
        "RESOURCE_LIMIT_EXCEEDED",
        "Local Markdown image exceeds its byte limit",
      );
    }

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= maximumBytes) {
      const remaining = maximumBytes + 1 - totalBytes;
      const chunk = Buffer.allocUnsafe(
        Math.min(IMAGE_READ_CHUNK_BYTES, remaining),
      );
      const bytesRead = readSync(
        descriptor,
        chunk,
        0,
        chunk.length,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > maximumBytes) {
        fail(
          "RESOURCE_LIMIT_EXCEEDED",
          "Local Markdown image exceeds its byte limit",
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }

    const after = fstatSync(descriptor);
    if (
      !Number.isSafeInteger(after.size) ||
      after.size < 0 ||
      after.size > maximumBytes
    ) {
      fail(
        "RESOURCE_LIMIT_EXCEEDED",
        "Local Markdown image exceeds its byte limit",
      );
    }
    if (
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs ||
      after.size !== totalBytes
    ) {
      fail("IMAGE_READ_FAILED", "Local Markdown image changed while reading", {
        operation: "read",
      });
    }
    return Buffer.concat(chunks, totalBytes);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function createIdAllocator() {
  const used = new Set();
  return function allocateId(base) {
    let candidate = truncateUtf8(base, MAX_HEADING_ID_BYTES);
    let suffix = 2;
    while (used.has(candidate)) {
      const suffixText = `-${suffix}`;
      candidate = `${truncateUtf8(
        base,
        MAX_HEADING_ID_BYTES - Buffer.byteLength(suffixText, "utf8"),
      )}${suffixText}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  };
}

function truncateUtf8(value, maximumBytes) {
  let result = "";
  let bytes = 0;
  for (const codePoint of String(value)) {
    const codePointBytes = Buffer.byteLength(codePoint, "utf8");
    if (bytes + codePointBytes > maximumBytes) break;
    result += codePoint;
    bytes += codePointBytes;
  }
  return result;
}

function createMarkdownAnalysisPlugin(headings, resourceLimits, allocateId) {
  return function markdownAnalysisPlugin() {
    return function analyze(tree) {
      const pending = [tree];
      let nodes = 0;
      while (pending.length > 0) {
        const node = pending.pop();
        nodes += 1;
        if (nodes > resourceLimits.canonicalJsonNodes) {
          fail(
            "RESOURCE_LIMIT_EXCEEDED",
            "Markdown input exceeds the syntax node limit",
          );
        }
        if (node?.type === "heading") {
          const text = markdownNodeText(node).trim();
          const base = slugify(text);
          headings.push({
            level: node.depth,
            text,
            id: allocateId(base),
          });
        }
        if (Array.isArray(node?.children)) {
          for (let index = node.children.length - 1; index >= 0; index -= 1) {
            pending.push(node.children[index]);
          }
        }
      }
    };
  };
}

function markdownNodeText(node) {
  if (node === null || typeof node !== "object") return "";
  if (node.type === "image" || node.type === "imageReference") {
    return typeof node.alt === "string" ? node.alt : "";
  }
  if (
    (node.type === "text" || node.type === "inlineCode" || node.type === "html") &&
    typeof node.value === "string"
  ) {
    return node.value;
  }
  if (!Array.isArray(node.children)) return "";
  return node.children.map(markdownNodeText).join("");
}

function reserveEmbeddedImage(renderBudget, resourceLimits, bytes) {
  renderBudget.embeddedImageBytes += bytes;
  if (renderBudget.embeddedImageBytes > resourceLimits.artifactBytes) {
    fail(
      "RESOURCE_LIMIT_EXCEEDED",
      "Embedded Markdown images exceed the artifact byte limit",
    );
  }
}

function dataUriBytes(mime, bytes) {
  return Buffer.byteLength(`data:${mime};base64,`, "utf8") +
    4 * Math.ceil(bytes / 3);
}

function resolveImage(
  src,
  sourceDirectory,
  { cache, imageIo, renderBudget, resourceLimits },
) {
  if (!src) {
    fail("INVALID_IMAGE_SOURCE", "Markdown image source is empty", {
      operation: "validate",
    });
  }
  if (/^data:image\//i.test(src)) {
    reserveEmbeddedImage(
      renderBudget,
      resourceLimits,
      Buffer.byteLength(src, "utf8"),
    );
    return { kind: "embedded", src };
  }
  if (/^https?:\/\//i.test(src) || src.startsWith("#")) {
    return { kind: "passive", href: src };
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(src) || src.startsWith("//")) {
    fail("INVALID_IMAGE_SOURCE", "Markdown image URL scheme is unsupported", {
      operation: "validate",
    });
  }
  let decoded;
  try {
    decoded = decodeURIComponent(src);
  } catch {
    fail("INVALID_IMAGE_SOURCE", "Markdown image path encoding is invalid", {
      operation: "decode",
    });
  }
  const path = isAbsolute(decoded)
    ? decoded
    : resolve(sourceDirectory, decoded);

  const cached = cache.get(path);
  if (cached !== undefined) {
    reserveEmbeddedImage(renderBudget, resourceLimits, cached.byteLength);
    return { kind: "embedded", src: cached.src };
  }

  let stats;
  try {
    stats = imageIo.stat(path);
  } catch (cause) {
    if (cause?.code === "ENOENT") return { kind: "passive", href: src };
    fail("IMAGE_READ_FAILED", "Unable to inspect a local Markdown image", {
      operation: "stat",
    });
  }
  if (!stats.isFile()) {
    return { kind: "passive", href: src };
  }

  const extension = extname(path).toLowerCase();
  const mime = IMAGE_MIME_TYPES.get(extension);
  if (!mime) {
    fail("UNSUPPORTED_IMAGE_TYPE", "Local Markdown image type is unsupported");
  }
  if (
    !Number.isSafeInteger(stats.size) ||
    stats.size < 0 ||
    stats.size > MAX_LOCAL_IMAGE_BYTES
  ) {
    fail("RESOURCE_LIMIT_EXCEEDED", "Local Markdown image exceeds its byte limit");
  }

  const projectedBytes = dataUriBytes(mime, stats.size);
  reserveEmbeddedImage(renderBudget, resourceLimits, projectedBytes);
  let bytes;
  try {
    bytes = imageIo.readFile(path, MAX_LOCAL_IMAGE_BYTES);
  } catch (cause) {
    if (
      cause instanceof ArtifactBuildError &&
      cause.code === "RESOURCE_LIMIT_EXCEEDED"
    ) {
      throw cause;
    }
    fail("IMAGE_READ_FAILED", "Unable to read a local Markdown image", {
      operation: "read",
    });
  }
  if (!Buffer.isBuffer(bytes)) {
    fail("IMAGE_READ_FAILED", "Local Markdown image did not produce bytes", {
      operation: "read",
    });
  }
  if (bytes.length > MAX_LOCAL_IMAGE_BYTES) {
    fail("RESOURCE_LIMIT_EXCEEDED", "Local Markdown image exceeds its byte limit");
  }
  const actualBytes = dataUriBytes(mime, bytes.length);
  renderBudget.embeddedImageBytes -= projectedBytes;
  reserveEmbeddedImage(renderBudget, resourceLimits, actualBytes);
  const dataUri = `data:${mime};base64,${bytes.toString("base64")}`;
  cache.set(path, { byteLength: actualBytes, src: dataUri });
  return { kind: "embedded", src: dataUri };
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
