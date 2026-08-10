import { parse, Tokenizer } from "parse5";

import { validateInlineStylesheet } from "./assets.mjs";
import { DATA_BLOCK_ID } from "./data-blocks.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import {
  asciiLowercase,
  isEventHandlerAttribute,
  isNetworkSideEffectAttribute,
  isUnsafePassiveNavigationUrl,
} from "./html-safety.mjs";
import { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";

const THEME_KEYS = new Set([
  "themeContractVersion",
  "id",
  "version",
  "displayName",
  "render",
]);
const INPUT_KEYS = new Set(["mode", "metadata", "content"]);
const METADATA_KEYS = new Set(["title", "description", "eyebrow", "lang"]);
const CONTENT_KEYS = new Set(["articleHtml", "headings", "slots", "svg"]);
const HEADING_KEYS = new Set(["id", "level", "text"]);
const SLOT_KEYS = new Set([
  "navigation",
  "heroSupplementary",
  "mainSections",
  "rail",
  "footer",
]);
const PREPARED_SVG_KEYS = new Set(["id", "label", "html", "byteLength"]);
const RESULT_KEYS = new Set(["lang", "styles", "bodyHtml"]);
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const THEME_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,62})$/;
const THEME_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const MAX_THEME_ID_BYTES = 128;
const MAX_THEME_VERSION_BYTES = 128;
const MAX_THEME_DISPLAY_NAME_BYTES = 256;
const MAX_RENDER_INPUT_DEPTH = 256;
const HTML_NAMESPACE = "http://www.w3.org/1999/xhtml";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const RESOURCE_ATTRIBUTES = new Set(["data", "poster", "src", "srcset"]);
const FORBIDDEN_ELEMENT_NAMES = new Set([
  "base",
  "body",
  "form",
  "head",
  "html",
  "iframe",
  "link",
  "meta",
  "noembed",
  "noframes",
  "noscript",
  "object",
  "plaintext",
  "script",
  "style",
  "template",
  "xmp",
]);
const FOREIGN_DOCUMENT_OWNERSHIP_NAMES = new Set(["body", "head", "html"]);
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
  "style",
  "video",
]);

function fail(code, message) {
  throw new ArtifactBuildError(code, message);
}

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function inspectRecord(value, allowedKeys, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be a plain object`);
  }
  let descriptors;
  let keys;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code, `${label} cannot be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain object`);
  }
  if (
    keys.length !== allowedKeys.size ||
    keys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
  ) {
    fail(code, `${label} has an invalid shape`);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      fail(code, `${label} contains an unsafe property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function inspectOptionalRecord(value, allowedKeys, code, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(code, `${label} must be a plain object`);
  }
  let descriptors;
  let keys;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail(code, `${label} cannot be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail(code, `${label} must be a plain object`);
  }
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !allowedKeys.has(key) ||
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      fail(code, `${label} contains an unsafe property`);
    }
    result[key] = descriptor.value;
  }
  return result;
}

function boundedNonEmptyString(value, maximumBytes) {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    byteLength(value) <= maximumBytes
  );
}

function validateTheme(theme) {
  const values = inspectRecord(theme, THEME_KEYS, "INVALID_THEME", "Theme");
  if (
    values.themeContractVersion !== 1 ||
    !boundedNonEmptyString(values.id, MAX_THEME_ID_BYTES) ||
    !THEME_ID.test(values.id) ||
    !boundedNonEmptyString(values.version, MAX_THEME_VERSION_BYTES) ||
    !THEME_VERSION.test(values.version) ||
    !boundedNonEmptyString(values.displayName, MAX_THEME_DISPLAY_NAME_BYTES) ||
    typeof values.render !== "function"
  ) {
    fail("INVALID_THEME", "Theme does not satisfy Theme Contract v1");
  }
  return values.render;
}

function cloneRenderInput(value) {
  const ancestors = new Set();
  const budget = {
    nodes: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
    bytes: ARTIFACT_RESOURCE_LIMITS.artifactBytes,
  };

  function clone(current, depth) {
    if (budget.nodes === 0 || depth > MAX_RENDER_INPUT_DEPTH) {
      fail("RESOURCE_LIMIT_EXCEEDED", "Theme render input exceeds resource limits");
    }
    budget.nodes -= 1;
    if (current === null || typeof current === "boolean") return current;
    if (typeof current === "string") {
      budget.bytes -= byteLength(current);
      if (budget.bytes < 0) {
        fail("RESOURCE_LIMIT_EXCEEDED", "Theme render input exceeds resource limits");
      }
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current) || Object.is(current, -0)) {
        fail("INVALID_THEME_INPUT", "Theme render input contains an unsafe value");
      }
      return current;
    }
    if (typeof current !== "object") {
      fail("INVALID_THEME_INPUT", "Theme render input contains an unsupported value");
    }
    if (ancestors.has(current)) {
      fail("INVALID_THEME_INPUT", "Theme render input contains a cycle");
    }

    let prototype;
    let keys;
    let descriptors;
    try {
      prototype = Object.getPrototypeOf(current);
      keys = Reflect.ownKeys(current);
      descriptors = Object.getOwnPropertyDescriptors(current);
    } catch {
      fail("INVALID_THEME_INPUT", "Theme render input cannot be inspected safely");
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (prototype !== Array.prototype) {
          fail("INVALID_THEME_INPUT", "Theme render input arrays must be plain arrays");
        }
        const lengthDescriptor = descriptors.length;
        const length = lengthDescriptor?.value;
        if (!Number.isSafeInteger(length) || length < 0 || keys.length !== length + 1) {
          fail("INVALID_THEME_INPUT", "Theme render input arrays must be dense");
        }
        const result = [];
        for (let index = 0; index < length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (
            descriptor === undefined ||
            !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
            descriptor.enumerable !== true
          ) {
            fail("INVALID_THEME_INPUT", "Theme render input arrays contain an unsafe property");
          }
          result.push(clone(descriptor.value, depth + 1));
        }
        if (
          keys.some(
            (key) =>
              key !== "length" &&
              (typeof key !== "string" || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= length),
          )
        ) {
          fail("INVALID_THEME_INPUT", "Theme render input arrays contain an extra property");
        }
        return Object.freeze(result);
      }

      if (prototype !== Object.prototype && prototype !== null) {
        fail("INVALID_THEME_INPUT", "Theme render input objects must be plain objects");
      }
      const result = {};
      for (const key of keys) {
        const descriptor = descriptors[key];
        if (
          typeof key !== "string" ||
          descriptor === undefined ||
          !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
          descriptor.enumerable !== true
        ) {
          fail("INVALID_THEME_INPUT", "Theme render input objects contain an unsafe property");
        }
        Object.defineProperty(result, key, {
          configurable: true,
          enumerable: true,
          value: clone(descriptor.value, depth + 1),
          writable: true,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  }

  return clone(value, 0);
}

function isString(value) {
  return typeof value === "string";
}

function validateRenderInput(input) {
  const root = inspectRecord(input, INPUT_KEYS, "INVALID_THEME_INPUT", "Theme render input");
  if (root.mode !== "note" && root.mode !== "interactive") {
    fail("INVALID_THEME_INPUT", "Theme render mode must be note or interactive");
  }
  const metadata = inspectRecord(
    root.metadata,
    METADATA_KEYS,
    "INVALID_THEME_INPUT",
    "Theme render metadata",
  );
  if (
    !isString(metadata.title) ||
    !isString(metadata.description) ||
    !isString(metadata.eyebrow) ||
    !isString(metadata.lang) ||
    !LANGUAGE.test(metadata.lang)
  ) {
    fail("INVALID_THEME_INPUT", "Theme render metadata is invalid");
  }
  const content = inspectOptionalRecord(
    root.content,
    CONTENT_KEYS,
    "INVALID_THEME_INPUT",
    "Theme render content",
  );
  if (content.articleHtml !== undefined && !isString(content.articleHtml)) {
    fail("INVALID_THEME_INPUT", "Theme article HTML must be a string");
  }
  if (content.headings !== undefined) {
    if (!Array.isArray(content.headings)) {
      fail("INVALID_THEME_INPUT", "Theme headings must be an array");
    }
    for (const heading of content.headings) {
      const values = inspectRecord(
        heading,
        HEADING_KEYS,
        "INVALID_THEME_INPUT",
        "Theme heading",
      );
      if (
        !boundedNonEmptyString(values.id, 256) ||
        !Number.isInteger(values.level) ||
        values.level < 1 ||
        values.level > 6 ||
        !isString(values.text)
      ) {
        fail("INVALID_THEME_INPUT", "Theme heading is invalid");
      }
    }
  }
  if (content.slots !== undefined) {
    const slots = inspectOptionalRecord(
      content.slots,
      SLOT_KEYS,
      "INVALID_THEME_INPUT",
      "Theme slots",
    );
    let aggregateBytes = 0;
    for (const slot of Object.values(slots)) {
      if (!isString(slot)) {
        fail("INVALID_THEME_INPUT", "Theme slots must contain strings");
      }
      const bytes = byteLength(slot);
      aggregateBytes += bytes;
      if (
        bytes > ARTIFACT_RESOURCE_LIMITS.slotBytes ||
        aggregateBytes > ARTIFACT_RESOURCE_LIMITS.slotAggregateBytes
      ) {
        fail("RESOURCE_LIMIT_EXCEEDED", "Theme slots exceed resource limits");
      }
    }
  }
  if (content.svg !== undefined) {
    const svg = inspectArbitraryRecord(content.svg, "Theme SVG registry");
    if (Object.keys(svg).length > ARTIFACT_RESOURCE_LIMITS.svgAssets) {
      fail("RESOURCE_LIMIT_EXCEEDED", "Theme SVG registry exceeds resource limits");
    }
    let aggregateBytes = 0;
    for (const [key, prepared] of Object.entries(svg)) {
      const values = inspectOptionalRecord(
        prepared,
        PREPARED_SVG_KEYS,
        "INVALID_THEME_INPUT",
        "Prepared SVG",
      );
      if (
        !DATA_BLOCK_ID.test(key) ||
        values.id !== key ||
        !isString(values.label) ||
        !isString(values.html) ||
        (values.byteLength !== undefined &&
          (!Number.isSafeInteger(values.byteLength) || values.byteLength < 0))
      ) {
        fail("INVALID_THEME_INPUT", "Prepared SVG is invalid");
      }
      aggregateBytes += byteLength(values.html);
      if (aggregateBytes > ARTIFACT_RESOURCE_LIMITS.svgBytes) {
        fail("RESOURCE_LIMIT_EXCEEDED", "Theme SVG registry exceeds resource limits");
      }
    }
  }
  return { metadata };
}

function inspectArbitraryRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_THEME_INPUT", `${label} must be a plain object`);
  }
  let descriptors;
  let keys;
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
    keys = Reflect.ownKeys(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    fail("INVALID_THEME_INPUT", `${label} cannot be inspected safely`);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_THEME_INPUT", `${label} must be a plain object`);
  }
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      descriptor === undefined ||
      !Object.prototype.hasOwnProperty.call(descriptor, "value") ||
      descriptor.enumerable !== true
    ) {
      fail("INVALID_THEME_INPUT", `${label} contains an unsafe property`);
    }
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: descriptor.value,
      writable: true,
    });
  }
  return result;
}

function validateHref(tagName, value) {
  if (tagName !== "a" && tagName !== "area" && !value.startsWith("#")) {
    fail("UNSAFE_THEME_OUTPUT", "Theme body contains an active resource URL");
  }
  if (isUnsafePassiveNavigationUrl(value)) {
    fail("UNSAFE_THEME_OUTPUT", "Theme body contains an unsafe navigation URL");
  }
}

function containsForeignDocumentOwnership(bodyHtml) {
  const foreignRoots = [];
  let unsafe = false;
  const handler = {
    onStartTag(token) {
      if (
        foreignRoots.length > 0 &&
        FOREIGN_DOCUMENT_OWNERSHIP_NAMES.has(token.tagName)
      ) {
        unsafe = true;
      }
      if (
        (token.tagName === "svg" || token.tagName === "math") &&
        token.selfClosing !== true
      ) {
        foreignRoots.push(token.tagName);
      }
    },
    onEndTag(token) {
      if (token.tagName === "svg" || token.tagName === "math") {
        if (foreignRoots.at(-1) !== token.tagName) {
          unsafe = true;
        } else {
          foreignRoots.pop();
        }
      }
    },
    onComment() {},
    onDoctype() {},
    onEof() {},
    onCharacter() {},
    onNullCharacter() {},
    onWhitespaceCharacter() {},
  };
  try {
    new Tokenizer({}, handler).write(bodyHtml, true);
  } catch {
    fail("UNSAFE_THEME_OUTPUT", "Theme body HTML cannot be tokenized safely");
  }
  return unsafe;
}

function validateThemeBody(bodyHtml, stylesBytes) {
  const bodyBytes = byteLength(bodyHtml);
  if (
    bodyBytes > ARTIFACT_RESOURCE_LIMITS.artifactBytes ||
    bodyBytes + stylesBytes > ARTIFACT_RESOURCE_LIMITS.artifactBytes
  ) {
    fail("RESOURCE_LIMIT_EXCEEDED", "Theme output exceeds resource limits");
  }
  if (containsForeignDocumentOwnership(bodyHtml)) {
    fail("UNSAFE_THEME_OUTPUT", "Theme body contains document ownership markup");
  }

  let document;
  try {
    document = parse(bodyHtml, { sourceCodeLocationInfo: true });
  } catch {
    fail("UNSAFE_THEME_OUTPUT", "Theme body HTML cannot be parsed safely");
  }
  const pending = [...(document.childNodes ?? [])];
  let nodes = 0;
  let svgCount = 0;
  let svgBytes = 0;
  while (pending.length > 0) {
    const node = pending.pop();
    nodes += 1;
    if (nodes > ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes) {
      fail("RESOURCE_LIMIT_EXCEEDED", "Theme body exceeds the node limit");
    }
    if (node.nodeName === "#documentType") {
      fail("UNSAFE_THEME_OUTPUT", "Theme body must not own the document doctype");
    }
    if (node.content?.childNodes) pending.push(...node.content.childNodes);
    if (node.childNodes) pending.push(...node.childNodes);
    if (typeof node.tagName !== "string") continue;

    const tagName = asciiLowercase(node.tagName);
    if (
      (FORBIDDEN_ELEMENT_NAMES.has(tagName) && node.sourceCodeLocation != null) ||
      (node.namespaceURI === HTML_NAMESPACE &&
        tagName === "title" &&
        node.sourceCodeLocation != null) ||
      (node.namespaceURI === SVG_NAMESPACE && FORBIDDEN_SVG_ELEMENTS.has(tagName))
    ) {
      fail("UNSAFE_THEME_OUTPUT", "Theme body contains an owned or active element");
    }
    if (tagName === "svg") {
      svgCount += 1;
      const location = node.sourceCodeLocation;
      if (
        Number.isSafeInteger(location?.startOffset) &&
        Number.isSafeInteger(location?.endOffset)
      ) {
        svgBytes += byteLength(bodyHtml.slice(location.startOffset, location.endOffset));
      }
      if (
        svgCount > ARTIFACT_RESOURCE_LIMITS.svgAssets ||
        svgBytes > ARTIFACT_RESOURCE_LIMITS.svgBytes
      ) {
        fail("RESOURCE_LIMIT_EXCEEDED", "Theme SVG output exceeds resource limits");
      }
    }

    for (const attribute of node.attrs ?? []) {
      const localName = asciiLowercase(attribute.name);
      const qualifiedName = attribute.prefix
        ? `${asciiLowercase(attribute.prefix)}:${localName}`
        : localName;
      if (
        isEventHandlerAttribute(localName) ||
        isEventHandlerAttribute(qualifiedName)
      ) {
        fail("UNSAFE_THEME_OUTPUT", "Theme body contains an event-handler attribute");
      }
      if (localName.startsWith("data-html-kit-")) {
        fail("UNSAFE_THEME_OUTPUT", "Theme body shadows an owned artifact protocol");
      }
      if (isNetworkSideEffectAttribute(qualifiedName)) {
        fail("UNSAFE_THEME_OUTPUT", "Theme body contains a network side-effect attribute");
      }
      if (localName === "href" || qualifiedName === "xlink:href") {
        validateHref(tagName, attribute.value);
      }
      if (RESOURCE_ATTRIBUTES.has(localName)) {
        if (
          tagName !== "img" ||
          localName !== "src" ||
          !asciiLowercase(attribute.value).startsWith("data:")
        ) {
          fail("UNSAFE_THEME_OUTPUT", "Theme body contains an external resource");
        }
      }
      if (localName === "style") {
        try {
          validateInlineStylesheet(attribute.value);
        } catch {
          fail("UNSAFE_THEME_OUTPUT", "Theme body contains an unsafe inline style");
        }
      }
    }
  }
}

function validateThemeResult(value, expectedLang) {
  const result = inspectRecord(
    value,
    RESULT_KEYS,
    "INVALID_THEME_OUTPUT",
    "Theme render result",
  );
  if (
    !isString(result.lang) ||
    !isString(result.styles) ||
    !isString(result.bodyHtml) ||
    !LANGUAGE.test(result.lang) ||
    result.lang !== expectedLang
  ) {
    fail("INVALID_THEME_OUTPUT", "Theme render result must contain valid strings");
  }
  const stylesBytes = byteLength(result.styles);
  if (stylesBytes > ARTIFACT_RESOURCE_LIMITS.stylesheetBytes) {
    fail("RESOURCE_LIMIT_EXCEEDED", "Theme stylesheet exceeds its byte limit");
  }
  if (/<\/style/i.test(result.styles)) {
    fail("INVALID_STYLESHEET", "Theme stylesheet contains unsafe raw text");
  }
  validateInlineStylesheet(result.styles);
  validateThemeBody(result.bodyHtml, stylesBytes);
  return Object.freeze({
    lang: result.lang,
    styles: result.styles,
    bodyHtml: result.bodyHtml,
  });
}

export function renderThemeV1(theme, input) {
  const render = validateTheme(theme);
  const clonedInput = cloneRenderInput(input);
  const { metadata } = validateRenderInput(clonedInput);
  let result;
  try {
    result = Reflect.apply(render, theme, [clonedInput]);
  } catch {
    throw new ArtifactBuildError(
      "THEME_RENDER_FAILED",
      "Theme rendering failed",
      { phase: "render" },
    );
  }
  return validateThemeResult(result, metadata.lang);
}
