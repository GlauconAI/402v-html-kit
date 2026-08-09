import vm from "node:vm";

import { parse } from "acorn";
import { JSDOM } from "jsdom";

import { DATA_BLOCK_ID } from "./data-blocks.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { readTrustedUtf8, resolveTrustedFile } from "./trusted-files.mjs";

const MAX_STYLESHEET_BYTES = 2 * 1024 * 1024;
const MAX_JAVASCRIPT_BYTES = 2 * 1024 * 1024;
const MAX_SVG_BYTES = 5 * 1024 * 1024;
const MAX_SVG_ELEMENTS = 5_000;
const MAX_SVG_DEPTH = 256;

const FORBIDDEN_CSS_RESOURCE_FUNCTIONS = new Set([
  "-webkit-image-set",
  "image",
  "image-set",
  "local",
  "src",
]);
const FORBIDDEN_SVG_ELEMENTS = new Set([
  "animate",
  "animatemotion",
  "animatetransform",
  "audio",
  "discard",
  "embed",
  "feimage",
  "foreignobject",
  "iframe",
  "image",
  "object",
  "script",
  "set",
  "video",
]);
const EXTERNAL_RESOURCE_ATTRIBUTES = new Set([
  "data",
  "ping",
  "poster",
  "src",
  "srcset",
  "xml:base",
]);
const SVG_INERT_METADATA_ATTRIBUTES = new Set(["class", "id", "role"]);
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const XMLNS_NAMESPACE = "http://www.w3.org/2000/xmlns/";

function fail(code, message, details = undefined) {
  throw new ArtifactBuildError(code, message, details);
}

export function resolveTrustedEntry(rootDirectory, source, internalOptions = undefined) {
  return {
    label: resolveTrustedFile(rootDirectory, source, {
      rootIdentity: internalOptions?.rootIdentity,
    }).label,
  };
}

function loadTrustedText(
  rootDirectory,
  source,
  maximumBytes,
  code,
  entryName,
  internalOptions,
) {
  const { byteLength, content, label } = readTrustedUtf8(rootDirectory, source, {
    maximumBytes,
    code,
    entryName,
    rootIdentity: internalOptions?.rootIdentity,
  });
  return { byteLength, content, label };
}

function assetResult(result, byteLength, internalOptions) {
  if (!internalOptions?.includeByteLength) return result;
  return { ...result, byteLength };
}

const HTML_SCRIPT_RAW_TEXT_MARKER = /<!--|<\/?script/i;

function isAstNode(value) {
  return (
    value !== null && typeof value === "object" && typeof value.type === "string"
  );
}

function containsImportExpression(root) {
  const pending = [root];
  while (pending.length > 0) {
    const node = pending.pop();
    if (node.type === "ImportExpression") return true;

    for (const value of Object.values(node)) {
      if (isAstNode(value)) {
        pending.push(value);
        continue;
      }
      if (!Array.isArray(value)) continue;
      for (const item of value) {
        if (isAstNode(item)) pending.push(item);
      }
    }
  }
  return false;
}

export function loadScriptEntry(rootDirectory, source, internalOptions = undefined) {
  const { byteLength, label, content } = loadTrustedText(
    rootDirectory,
    source,
    MAX_JAVASCRIPT_BYTES,
    "INVALID_JAVASCRIPT",
    "JavaScript entry",
    internalOptions,
  );

  if (/sourceMappingURL/i.test(content) || HTML_SCRIPT_RAW_TEXT_MARKER.test(content)) {
    fail("INVALID_JAVASCRIPT", "JavaScript entry contains forbidden syntax", {
      label,
    });
  }

  let program;
  try {
    program = parse(content, { ecmaVersion: "latest", sourceType: "script" });
  } catch {
    fail("INVALID_JAVASCRIPT", "JavaScript entry is not a valid classic script", {
      label,
    });
  }
  if (containsImportExpression(program)) {
    fail("INVALID_JAVASCRIPT", "JavaScript entry contains forbidden syntax", {
      label,
    });
  }

  try {
    new vm.Script(content, { filename: label });
  } catch {
    fail("INVALID_JAVASCRIPT", "JavaScript entry is not a valid classic script", {
      label,
    });
  }

  return assetResult({ label, content }, byteLength, internalOptions);
}

function isCssWhitespace(character) {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f"
  );
}

function isCssHexDigit(character) {
  return character !== undefined && /[0-9A-Fa-f]/.test(character);
}

function isCssIdentifierCharacter(character) {
  return (
    character !== undefined &&
    (/[A-Za-z0-9_-]/.test(character) || character.codePointAt(0) >= 0x80)
  );
}

function skipCssWhitespace(content, index) {
  while (isCssWhitespace(content[index])) index += 1;
  return index;
}

function decodeCssEscape(content, index, allowControl = false) {
  let cursor = index + 1;
  const first = content[cursor];
  if (
    first === undefined ||
    first === "\0" ||
    first === "\n" ||
    first === "\r" ||
    first === "\f"
  ) {
    return { valid: false, end: cursor };
  }

  if (!isCssHexDigit(first)) {
    return { valid: true, value: first, end: cursor + 1 };
  }

  const start = cursor;
  while (cursor - start < 6 && isCssHexDigit(content[cursor])) cursor += 1;
  const codePoint = Number.parseInt(content.slice(start, cursor), 16);
  if (
    codePoint === 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
    (!allowControl && (codePoint <= 0x1f || codePoint === 0x7f))
  ) {
    return { valid: false, end: cursor };
  }

  if (content[cursor] === "\r" && content[cursor + 1] === "\n") {
    cursor += 2;
  } else if (isCssWhitespace(content[cursor])) {
    cursor += 1;
  }

  return { valid: true, value: String.fromCodePoint(codePoint), end: cursor };
}

function skipCssString(content, index) {
  const quote = content[index];
  let cursor = index + 1;
  while (cursor < content.length) {
    const character = content[cursor];
    if (character === quote) return { valid: true, end: cursor + 1 };
    if (character === "\n" || character === "\r" || character === "\f") {
      return { valid: false, end: cursor };
    }
    if (character !== "\\") {
      cursor += 1;
      continue;
    }

    const escaped = content[cursor + 1];
    if (escaped === "\r" && content[cursor + 2] === "\n") {
      cursor += 3;
    } else if (escaped === "\n" || escaped === "\r" || escaped === "\f") {
      cursor += 2;
    } else {
      const escape = decodeCssEscape(content, cursor, true);
      if (!escape.valid) return { valid: false, end: escape.end };
      cursor = escape.end;
    }
  }
  return { valid: false, end: cursor };
}

function readCssIdentifier(content, index) {
  let cursor = index;
  let value = "";
  while (cursor < content.length) {
    if (isCssIdentifierCharacter(content[cursor])) {
      value += content[cursor];
      cursor += 1;
      continue;
    }
    if (content[cursor] !== "\\") break;

    const escape = decodeCssEscape(content, cursor);
    if (!escape.valid) return { valid: false, end: escape.end };
    value += escape.value;
    cursor = escape.end;
  }
  return { valid: true, value, end: cursor };
}

function readCssString(content, index) {
  const quote = content[index];
  let cursor = index + 1;
  let value = "";
  while (cursor < content.length) {
    const character = content[cursor];
    if (character === quote) {
      return { valid: true, value, end: cursor + 1 };
    }
    if (
      character === "\n" ||
      character === "\r" ||
      character === "\f" ||
      character === "\0"
    ) {
      return { valid: false, end: cursor };
    }
    if (character === "\\") {
      const escape = decodeCssEscape(content, cursor);
      if (!escape.valid) return { valid: false, end: escape.end };
      value += escape.value;
      cursor = escape.end;
    } else {
      value += character;
      cursor += 1;
    }
  }
  return { valid: false, end: cursor };
}

function readCssUrl(content, openingParenthesis) {
  let cursor = skipCssWhitespace(content, openingParenthesis + 1);
  let value = "";

  if (content[cursor] === '"' || content[cursor] === "'") {
    const string = readCssString(content, cursor);
    if (!string.valid) return { valid: false, end: string.end };
    value = string.value;
    cursor = skipCssWhitespace(content, string.end);
  } else {
    let trailingWhitespace = false;
    while (cursor < content.length && content[cursor] !== ")") {
      const character = content[cursor];
      if (isCssWhitespace(character)) {
        trailingWhitespace = true;
        cursor += 1;
        continue;
      }
      if (
        trailingWhitespace ||
        character === '"' ||
        character === "'" ||
        character === "(" ||
        character === "\0"
      ) {
        return { valid: false, end: cursor };
      }
      if (character === "\\") {
        const escape = decodeCssEscape(content, cursor);
        if (!escape.valid) return { valid: false, end: escape.end };
        value += escape.value;
        cursor = escape.end;
      } else {
        value += character;
        cursor += 1;
      }
    }
  }

  if (content[cursor] !== ")") return { valid: false, end: cursor };
  return { valid: true, value, end: cursor + 1 };
}

function scanCss(content) {
  const urls = [];
  let index = 0;

  while (index < content.length) {
    if (content.startsWith("/*", index)) {
      const end = content.indexOf("*/", index + 2);
      if (end === -1) return { invalid: true, hasImport: false, urls };
      index = end + 2;
      continue;
    }

    const character = content[index];
    if (character === '"' || character === "'") {
      const string = skipCssString(content, index);
      if (!string.valid) return { invalid: true, hasImport: false, urls };
      index = string.end;
      continue;
    }

    if (character === "@") {
      const identifier = readCssIdentifier(content, index + 1);
      if (!identifier.valid) return { invalid: true, hasImport: false, urls };
      if (identifier.value.toLowerCase() === "import") {
        return { invalid: false, hasImport: true, urls };
      }
      index = Math.max(index + 1, identifier.end);
      continue;
    }

    if (isCssIdentifierCharacter(character) || character === "\\") {
      const identifier = readCssIdentifier(content, index);
      if (!identifier.valid) return { invalid: true, hasImport: false, urls };
      let cursor = skipCssWhitespace(content, identifier.end);
      const functionName = identifier.value.toLowerCase();
      if (
        content[cursor] === "(" &&
        FORBIDDEN_CSS_RESOURCE_FUNCTIONS.has(functionName)
      ) {
        return { invalid: true, hasImport: false, urls };
      }
      if (functionName === "url" && content[cursor] === "(") {
        const url = readCssUrl(content, cursor);
        if (!url.valid) return { invalid: true, hasImport: false, urls };
        urls.push(url.value);
        index = url.end;
        continue;
      }
      index = Math.max(index + 1, identifier.end);
      continue;
    }

    if (character === "\0") {
      return { invalid: true, hasImport: false, urls };
    }
    index += 1;
  }

  return { invalid: false, hasImport: false, urls };
}

function hasUnsafeCss(content, allowedSchemes) {
  const { invalid, hasImport, urls } = scanCss(content);
  if (invalid || hasImport) return true;
  return urls.some((value) => {
    if (value.length === 0 || /^\s|\s$/u.test(value)) return true;
    const normalized = value.toLowerCase();
    return !allowedSchemes.some((prefix) => normalized.startsWith(prefix));
  });
}

export function validateInlineStylesheet(content) {
  if (typeof content !== "string" || hasUnsafeCss(content, ["data:", "#"])) {
    fail("INVALID_STYLESHEET", "Inline stylesheet contains an unsafe dependency");
  }
  return content;
}

export function validateInlineSvgStyle(content) {
  if (typeof content !== "string" || hasUnsafeCss(content, ["#"])) {
    fail("UNSAFE_SVG", "Inline SVG style contains an unsafe dependency");
  }
  return content;
}

export function loadStylesheetEntry(
  rootDirectory,
  source,
  internalOptions = undefined,
) {
  const { byteLength, label, content } = loadTrustedText(
    rootDirectory,
    source,
    MAX_STYLESHEET_BYTES,
    "INVALID_STYLESHEET",
    "Stylesheet entry",
    internalOptions,
  );

  if (/<\/style/i.test(content)) {
    fail("INVALID_STYLESHEET", "Stylesheet entry contains an unsafe dependency", {
      label,
    });
  }
  try {
    validateInlineStylesheet(content);
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) {
      fail("INVALID_STYLESHEET", "Stylesheet entry contains an unsafe dependency", {
        label,
      });
    }
    throw cause;
  }

  return assetResult({ label, content }, byteLength, internalOptions);
}

function validateSvgDefinition(definition) {
  if (definition === null || typeof definition !== "object") {
    fail("UNSAFE_SVG", "SVG definition must be an object");
  }
  if (typeof definition.id !== "string" || !DATA_BLOCK_ID.test(definition.id)) {
    fail("UNSAFE_SVG", "SVG id must match DATA_BLOCK_ID");
  }
  if (
    definition.title !== undefined &&
    (typeof definition.title !== "string" || definition.title.trim().length === 0)
  ) {
    fail("UNSAFE_SVG", "SVG title must be a non-empty string");
  }
  if (
    definition.description !== undefined &&
    typeof definition.description !== "string"
  ) {
    fail("UNSAFE_SVG", "SVG description must be a string");
  }
}

function directChildrenByName(root, name) {
  const matches = [];
  for (
    let child = root.firstElementChild;
    child !== null;
    child = child.nextElementSibling
  ) {
    if (
      child.localName.toLowerCase() === name &&
      isUnprefixedSvgElement(child)
    ) {
      matches.push(child);
    }
  }
  return matches;
}

function firstNonEmpty(elements) {
  return elements.find((element) => (element.textContent ?? "").trim().length > 0);
}

function hasIdCollision(root, id, allowedElement) {
  for (const { element } of iterateSvgElements(root)) {
    if (element !== allowedElement && element.getAttribute("id") === id) {
      return true;
    }
  }
  return false;
}

function isInertSvgMetadataAttribute(attribute, name, localName) {
  return (
    SVG_INERT_METADATA_ATTRIBUTES.has(name) ||
    SVG_INERT_METADATA_ATTRIBUTES.has(localName) ||
    name.startsWith("aria-") ||
    name.startsWith("data-") ||
    attribute.namespaceURI === XMLNS_NAMESPACE ||
    name === "xmlns" ||
    name.startsWith("xmlns:")
  );
}

function isUnprefixedSvgElement(element) {
  return element.namespaceURI === SVG_NAMESPACE && element.prefix === null;
}

function* iterateSvgElements(root) {
  const pending = [{ element: root, depth: 1 }];
  while (pending.length > 0) {
    const current = pending.pop();
    yield current;

    for (
      let child = current.element.lastElementChild;
      child !== null;
      child = child.previousElementSibling
    ) {
      pending.push({ element: child, depth: current.depth + 1 });
    }
  }
}

function validateSvgTree(root) {
  let elementCount = 0;
  for (const { element, depth } of iterateSvgElements(root)) {
    elementCount += 1;
    if (elementCount > MAX_SVG_ELEMENTS) {
      fail("UNSAFE_SVG", "SVG exceeds the maximum element count", {
        maximumElements: MAX_SVG_ELEMENTS,
      });
    }
    if (depth > MAX_SVG_DEPTH) {
      fail("UNSAFE_SVG", "SVG exceeds the maximum element depth", {
        maximumDepth: MAX_SVG_DEPTH,
      });
    }

    const elementName = element.localName.toLowerCase();
    if (!isUnprefixedSvgElement(element)) {
      fail("UNSAFE_SVG", "SVG elements must be unprefixed SVG namespace elements", {
        element: elementName,
      });
    }
    if (FORBIDDEN_SVG_ELEMENTS.has(elementName)) {
      fail("UNSAFE_SVG", "SVG contains a forbidden element", {
        element: elementName,
      });
    }

    for (const attribute of element.attributes) {
      const name = attribute.name.toLowerCase();
      const localName = attribute.localName.toLowerCase();
      const value = attribute.value;
      if (name.startsWith("on") || localName.startsWith("on")) {
        fail("UNSAFE_SVG", "SVG contains an event-handler attribute", {
          attribute: name,
        });
      }
      if (
        localName === "href" &&
        (!value.startsWith("#") || /^\s|\s$/u.test(value))
      ) {
        fail("UNSAFE_SVG", "SVG contains an external reference", {
          attribute: name,
        });
      }
      if (localName === "href") continue;
      if (
        EXTERNAL_RESOURCE_ATTRIBUTES.has(name) ||
        EXTERNAL_RESOURCE_ATTRIBUTES.has(localName)
      ) {
        fail("UNSAFE_SVG", "SVG contains an external resource reference", {
          attribute: name,
        });
      }
      if (
        !isInertSvgMetadataAttribute(attribute, name, localName) &&
        hasUnsafeCss(attribute.value, ["#"])
      ) {
        fail("UNSAFE_SVG", "SVG contains an external resource reference", {
          attribute: name,
        });
      }
    }

    if (elementName === "style") {
      if (hasUnsafeCss(element.textContent ?? "", ["#"])) {
        fail("UNSAFE_SVG", "SVG style contains an external resource reference");
      }
    }
  }
}

function setAccessibleText(root, definition) {
  const namespace = root.namespaceURI;
  const titleElements = directChildrenByName(root, "title");
  const descriptionElements = directChildrenByName(root, "desc");

  let title =
    definition.title === undefined
      ? firstNonEmpty(titleElements)
      : titleElements[0];
  if (title === undefined && definition.title !== undefined) {
    title = root.ownerDocument.createElementNS(namespace, "title");
  }
  if (title === undefined) {
    fail("UNSAFE_SVG", "SVG requires a non-empty accessible title");
  }
  if (definition.title !== undefined) title.textContent = definition.title;
  if ((title.textContent ?? "").trim().length === 0) {
    fail("UNSAFE_SVG", "SVG requires a non-empty accessible title");
  }

  let description =
    definition.description === undefined
      ? firstNonEmpty(descriptionElements)
      : descriptionElements[0];
  if (description === undefined && definition.description !== undefined) {
    description = root.ownerDocument.createElementNS(namespace, "desc");
  }
  if (definition.description !== undefined) {
    description.textContent = definition.description;
  }
  if ((description?.textContent ?? "").trim().length === 0) {
    description = undefined;
  }

  for (const element of titleElements) {
    if (element !== title) element.remove();
  }
  for (const element of descriptionElements) {
    if (element !== description) element.remove();
  }

  const titleId = `${definition.id}-title`;
  const descriptionId = `${definition.id}-description`;
  if (hasIdCollision(root, titleId, title)) {
    fail("UNSAFE_SVG", "SVG accessible title id collides with existing content");
  }
  if (description !== undefined && hasIdCollision(root, descriptionId, description)) {
    fail("UNSAFE_SVG", "SVG accessible description id collides with existing content");
  }

  title.setAttribute("id", titleId);
  root.insertBefore(title, root.firstChild);
  const labelledBy = [titleId];
  if (description !== undefined) {
    description.setAttribute("id", descriptionId);
    root.insertBefore(description, title.nextSibling);
    labelledBy.push(descriptionId);
  }
  root.setAttribute("aria-labelledby", labelledBy.join(" "));
}

function serializeSvgFrame(root, id) {
  const outputDom = new JSDOM("<!doctype html><body></body>");
  try {
    const document = outputDom.window.document;
    const frame = document.createElement("div");
    frame.className = "artifact-svg-frame";
    frame.setAttribute(
      "style",
      "max-width: 100% !important; overflow-x: auto !important;",
    );
    frame.setAttribute("data-svg-id", id);
    frame.append(document.importNode(root, true));
    return frame.outerHTML;
  } finally {
    outputDom.window.close();
  }
}

export function loadSvgAsset(rootDirectory, definition, internalOptions = undefined) {
  let dom;
  let label;
  let byteLength;
  try {
    validateSvgDefinition(definition);
    const loaded = loadTrustedText(
      rootDirectory,
      definition.source,
      MAX_SVG_BYTES,
      "UNSAFE_SVG",
      "SVG asset",
      internalOptions,
    );
    label = loaded.label;
    byteLength = loaded.byteLength;

    if (/<\s*!(?:doctype|entity)\b/i.test(loaded.content)) {
      fail("UNSAFE_SVG", "SVG declarations are not allowed", {
        label,
      });
    }

    try {
      dom = new JSDOM(loaded.content, { contentType: "image/svg+xml" });
    } catch {
      fail("UNSAFE_SVG", "Unable to parse SVG asset", { label });
    }

    const root = dom.window.document.documentElement;
    if (root.localName !== "svg" || !isUnprefixedSvgElement(root)) {
      fail("UNSAFE_SVG", "SVG asset must have an svg root element", {
        label,
      });
    }
    const viewBox = root.getAttribute("viewBox");
    if (viewBox === null || viewBox.trim().length === 0) {
      fail("UNSAFE_SVG", "SVG asset requires a non-empty viewBox", {
        label,
      });
    }

    validateSvgTree(root);
    setAccessibleText(root, definition);
    root.setAttribute("role", "img");
    root.classList.add("artifact-svg");

    return assetResult(
      {
        id: definition.id,
        label,
        html: serializeSvgFrame(root, definition.id),
      },
      byteLength,
      internalOptions,
    );
  } catch (error) {
    if (error instanceof ArtifactBuildError) throw error;
    fail(
      "UNSAFE_SVG",
      "Unable to safely process SVG asset",
      label === undefined ? undefined : { label },
    );
  } finally {
    try {
      dom?.window.close();
    } catch {
      // Closing a failed parser must not replace the stable public error.
    }
  }
}
