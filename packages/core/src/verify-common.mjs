import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import vm from "node:vm";

import { parse } from "acorn";
import { JSDOM } from "jsdom";

import {
  validateInlineStylesheet,
  validateInlineSvgStyle,
} from "./assets.mjs";
import {
  computeSourceHash,
  DATA_BLOCK_ID,
  stableJson,
} from "./data-blocks.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { findMetaElements } from "./meta.mjs";

const require = createRequire(import.meta.url);
const jsdomEntryUrl = pathToFileURL(require.resolve("jsdom")).href;
const DEFAULT_STARTUP_TIMEOUT_MS = 8_000;
const MAX_STARTUP_TIMEOUT_MS = 10_000;
const MAX_STARTUP_OUTPUT_BYTES = 1024 * 1024;
const APPLICATION_JSON = /^application\/json$/i;
const LEGACY_JAVASCRIPT_MIME_TYPES = new Set([
  "application/ecmascript",
  "application/javascript",
  "application/x-ecmascript",
  "application/x-javascript",
  "text/ecmascript",
  "text/javascript",
  "text/javascript1.0",
  "text/javascript1.1",
  "text/javascript1.2",
  "text/javascript1.3",
  "text/javascript1.4",
  "text/javascript1.5",
  "text/jscript",
  "text/livescript",
  "text/x-ecmascript",
  "text/x-javascript",
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

const STARTUP_PROGRAM = `
import fs from "node:fs";
import jsdom from ${JSON.stringify(jsdomEntryUrl)};
const { JSDOM, VirtualConsole } = jsdom;
const html = fs.readFileSync(0, "utf8");
const errors = [];
const record = (value) => {
  const message = typeof value === "string" ? value : value?.message;
  errors.push(String(message || "Unknown startup error").slice(0, 2048));
};
const virtualConsole = new VirtualConsole();
virtualConsole.on("jsdomError", (error) => {
  if (error?.type === "unhandled-exception" || error?.type === "unhandled-rejection") {
    record(error.cause || error);
  }
});
let dom;
try {
  dom = new JSDOM(html, {
    runScripts: "dangerously",
    virtualConsole,
    url: "https://artifact.invalid/",
    beforeParse(window) {
      window.addEventListener("error", (event) => {
        record(event.error || event.message);
        event.preventDefault();
      });
      window.addEventListener("unhandledrejection", (event) => {
        record(event.reason);
        event.preventDefault();
      });
    },
  });
  const mode = dom.window.document
    .querySelector('meta[name="402v-artifact-mode"]')
    ?.getAttribute("content");
  if (mode === "interactive") {
    const descriptor = Object.getOwnPropertyDescriptor(dom.window, "__402vArtifact");
    const api = descriptor?.value;
    if (
      descriptor?.configurable !== false ||
      descriptor?.writable !== false ||
      api === null ||
      typeof api !== "object" ||
      !Object.isFrozen(api) ||
      typeof api.getData !== "function" ||
      typeof api.dataIds !== "function"
    ) {
      record("Interactive artifact runtime did not initialize safely");
    } else {
      try {
        const nodes = Array.from(
          dom.window.document.querySelectorAll('script[type="application/json"][id]'),
        );
        const expectedIds = nodes.map((node) => node.id);
        const actualIds = api.dataIds();
        const idsMatch =
          Array.isArray(actualIds) &&
          actualIds.length === expectedIds.length &&
          actualIds.every((id, index) => id === expectedIds[index]);
        const dataMatch = nodes.every(
          (node) => JSON.stringify(api.getData(node.id)) === JSON.stringify(JSON.parse(node.textContent)),
        );
        if (
          api.root !== dom.window.document.querySelector("[data-artifact-root]") ||
          !idsMatch ||
          !dataMatch
        ) {
          record("Interactive artifact runtime does not expose canonical script data");
        }
      } catch (error) {
        record(error);
      }
    }
  }
} catch (error) {
  record(error);
} finally {
  try { dom?.window.close(); } catch {}
}
process.stdout.write(JSON.stringify({ errors }));
`;

export function issue(code, message, details = undefined) {
  return details === undefined ? { code, message } : { code, message, details };
}

export function failVerification(issues) {
  throw new ArtifactBuildError(
    "ARTIFACT_VERIFICATION_FAILED",
    "Artifact verification found one or more issues",
    { issues },
  );
}

export function inspectOptions(options, allowed) {
  if (options === undefined) return Object.create(null);
  if (options === null || typeof options !== "object" || Array.isArray(options)) {
    failVerification([
      issue("INVALID_VERIFICATION_OPTIONS", "Verification options must be a plain object"),
    ]);
  }
  let descriptors;
  let keys;
  let prototype;
  try {
    descriptors = Object.getOwnPropertyDescriptors(options);
    keys = Reflect.ownKeys(options);
    prototype = Object.getPrototypeOf(options);
  } catch {
    failVerification([
      issue("INVALID_VERIFICATION_OPTIONS", "Verification options cannot be inspected safely"),
    ]);
  }
  if (prototype !== Object.prototype && prototype !== null) {
    failVerification([
      issue("INVALID_VERIFICATION_OPTIONS", "Verification options must be a plain object"),
    ]);
  }
  const values = Object.create(null);
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (
      typeof key !== "string" ||
      !allowed.has(key) ||
      descriptor === undefined ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      failVerification([
        issue("INVALID_VERIFICATION_OPTIONS", "Verification options contain an invalid property"),
      ]);
    }
    values[key] = descriptor.value;
  }
  return values;
}

export function requiredDataBlocks(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    failVerification([
      issue("INVALID_VERIFICATION_OPTIONS", "requiredDataBlocks must be an array"),
    ]);
  }
  const result = [];
  const seen = new Set();
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    const id = descriptor?.value;
    if (
      descriptor === undefined ||
      "get" in descriptor ||
      "set" in descriptor ||
      typeof id !== "string" ||
      !DATA_BLOCK_ID.test(id) ||
      seen.has(id)
    ) {
      failVerification([
        issue(
          "INVALID_VERIFICATION_OPTIONS",
          "requiredDataBlocks must contain unique valid data block IDs",
        ),
      ]);
    }
    seen.add(id);
    result.push(id);
  }
  return result;
}

export function addUniqueMetaIssue(issues, document, name, expected, code, label) {
  const matches = findMetaElements(document, name);
  if (matches.length !== 1 || matches[0].getAttribute("content") !== expected) {
    issues.push(issue(code, `Artifact requires exactly one valid ${label}`));
  }
}

function isAstNode(value) {
  return value !== null && typeof value === "object" && typeof value.type === "string";
}

function containsImport(program) {
  const pending = [program];
  while (pending.length > 0) {
    const node = pending.pop();
    if (
      node.type === "ImportExpression" ||
      node.type === "ImportDeclaration" ||
      node.type === "ExportAllDeclaration" ||
      node.type === "ExportNamedDeclaration"
    ) {
      return true;
    }
    for (const value of Object.values(node)) {
      if (isAstNode(value)) pending.push(value);
      if (Array.isArray(value)) {
        for (const child of value) if (isAstNode(child)) pending.push(child);
      }
    }
  }
  return false;
}

export function validClassicScript(content) {
  try {
    const program = parse(content, {
      ecmaVersion: "latest",
      sourceType: "script",
    });
    if (containsImport(program) || /sourceMappingURL/i.test(content)) return false;
    new vm.Script(content);
    return true;
  } catch {
    return false;
  }
}

export function hasClassicScriptType(script) {
  const type = script.getAttribute("type");
  if (type === null) return true;
  const normalized = type
    .replace(/^[\t\n\f\r ]+|[\t\n\f\r ]+$/g, "")
    .replace(/[A-Z]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) + 0x20),
    );
  return normalized === "" || LEGACY_JAVASCRIPT_MIME_TYPES.has(normalized);
}

export function verifyResources(document, issues, mode) {
  for (const script of document.querySelectorAll("script[src]")) {
    issues.push(issue("EXTERNAL_RESOURCE", "Artifact scripts must be inline"));
  }
  if (mode === "note") return;
  for (const link of document.querySelectorAll("link[href]")) {
    issues.push(issue("EXTERNAL_RESOURCE", "Artifact link resources are unresolved"));
  }
  for (const base of document.querySelectorAll("base[href]")) {
    issues.push(issue("EXTERNAL_RESOURCE", "Artifact must not redefine its resource base"));
  }
  for (const element of document.querySelectorAll("iframe, object, embed")) {
    issues.push(issue("EXTERNAL_RESOURCE", "Artifact contains an external runtime element"));
  }
  for (const image of document.querySelectorAll("img[src]")) {
    const source = image.getAttribute("src") ?? "";
    if (!source.toLowerCase().startsWith("data:")) {
      issues.push(issue("EXTERNAL_RESOURCE", "Artifact image resources must be inline data URLs"));
    }
  }
  for (const element of document.querySelectorAll(
    "source[src], source[srcset], audio[src], video[src], video[poster], track[src]",
  )) {
    issues.push(issue("EXTERNAL_RESOURCE", "Artifact media resources must be fully inline"));
  }
  for (const element of document.querySelectorAll("[src], [srcset], [poster], object[data]")) {
    const name = element.localName.toLowerCase();
    if (
      name !== "script" &&
      name !== "img" &&
      name !== "source" &&
      name !== "audio" &&
      name !== "video" &&
      name !== "track" &&
      name !== "object"
    ) {
      issues.push(issue("EXTERNAL_RESOURCE", "Artifact contains an unresolved element resource"));
    }
    if (name === "img" && element.hasAttribute("srcset")) {
      issues.push(issue("EXTERNAL_RESOURCE", "Artifact image srcset resources are unresolved"));
    }
  }
  for (const style of document.querySelectorAll("style")) {
    try {
      validateInlineStylesheet(style.textContent ?? "");
    } catch {
      issues.push(issue("UNSAFE_STYLESHEET", "Artifact contains an unsafe or unresolved stylesheet dependency"));
    }
  }
  for (const element of document.querySelectorAll("[style]")) {
    try {
      validateInlineStylesheet(element.getAttribute("style") ?? "");
    } catch {
      issues.push(issue("UNSAFE_STYLESHEET", "Artifact contains an unsafe inline style dependency"));
    }
  }
}

export function verifyData(document, rawHtml, nodeLocation, required, mode, issues) {
  const blocks = new Map();
  const nodes = [];
  const seenIds = new Set();
  const duplicateIds = new Set();
  for (const script of document.querySelectorAll("script")) {
    const type = script.getAttribute("type");
    if (type === null || !APPLICATION_JSON.test(type)) continue;
    nodes.push(script);
    if (type !== "application/json") {
      issues.push(issue("NON_CANONICAL_DATA_BLOCK", "JSON data block type must use the canonical spelling"));
    }
    const id = script.getAttribute("id");
    if (id === null || !DATA_BLOCK_ID.test(id)) {
      issues.push(issue("INVALID_DATA_BLOCK", "JSON data script has an invalid or missing ID"));
      continue;
    }
    if (seenIds.has(id)) {
      issues.push(issue("DUPLICATE_DATA_BLOCK", "JSON data block IDs must be unique", { id }));
      duplicateIds.add(id);
      continue;
    }
    seenIds.add(id);
    const location = nodeLocation(script);
    const startOffset = location?.startTag?.endOffset;
    const endOffset = location?.endTag?.startOffset;
    const rawContent =
      Number.isSafeInteger(startOffset) &&
      Number.isSafeInteger(endOffset) &&
      startOffset <= endOffset
        ? rawHtml.slice(startOffset, endOffset)
        : undefined;
    let value;
    try {
      value = JSON.parse(rawContent ?? "");
    } catch {
      issues.push(issue("INVALID_DATA_BLOCK", "JSON data block contains malformed JSON", { id }));
      continue;
    }
    let expected;
    try {
      expected = `\n${stableJson(value)}\n`;
    } catch {
      issues.push(issue("NON_CANONICAL_DATA_BLOCK", "JSON data block cannot be represented canonically", { id }));
      continue;
    }
    if (rawContent !== expected) {
      issues.push(issue("NON_CANONICAL_DATA_BLOCK", "JSON data block is not canonically serialized", { id }));
    }
    blocks.set(id, value);
  }

  const allIdElements = [...document.querySelectorAll("[id]")];
  for (const id of seenIds) {
    if (
      !duplicateIds.has(id) &&
      allIdElements.filter((element) => element.getAttribute("id") === id).length > 1
    ) {
      issues.push(issue("DUPLICATE_DATA_BLOCK", "JSON data block ID collides with another document element", { id }));
    }
  }

  for (const id of required) {
    if (!blocks.has(id)) {
      issues.push(issue("MISSING_DATA_BLOCK", "Required JSON data block is missing", { id }));
    }
  }

  let sourceHash;
  if (mode === "interactive" && blocks.size > 0) {
    try {
      sourceHash = computeSourceHash(blocks);
    } catch {
      issues.push(issue("INVALID_DATA_BLOCK", "JSON data blocks cannot be hashed canonically"));
    }
  } else if (mode === "interactive") {
    sourceHash = computeSourceHash(new Map());
  }
  const hashMetas = findMetaElements(document, "402v-source-hash");
  if (
    mode === "interactive" &&
    (hashMetas.length !== 1 || hashMetas[0].getAttribute("content") !== sourceHash)
  ) {
    issues.push(issue("SOURCE_HASH_MISMATCH", "Embedded source hash does not match canonical data"));
  }
  if (mode === "note" && (nodes.length > 0 || hashMetas.length > 0)) {
    issues.push(issue("INVALID_MODE", "Note artifacts must not contain interactive data declarations"));
  }
  return { blocks, nodes, sourceHash };
}

export function verifySvg(document, issues) {
  for (const svg of document.querySelectorAll("svg")) {
    if (!(svg.getAttribute("viewBox") ?? "").trim()) {
      issues.push(issue("SVG_MISSING_VIEWBOX", "SVG requires a non-empty viewBox"));
    }
    const labelledBy = (svg.getAttribute("aria-labelledby") ?? "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const title = labelledBy.length > 0 ? document.getElementById(labelledBy[0]) : null;
    if (
      svg.getAttribute("role") !== "img" ||
      title?.closest("svg") !== svg ||
      title.localName.toLowerCase() !== "title" ||
      !(title.textContent ?? "").trim()
    ) {
      issues.push(issue("SVG_INACCESSIBLE", "SVG requires local labelled title accessibility metadata"));
    }
    if (!svg.parentElement?.classList.contains("artifact-svg-frame")) {
      issues.push(issue("SVG_MISSING_FRAME", "SVG requires an artifact SVG scroll frame"));
    }

    const elements = [svg, ...svg.querySelectorAll("*")];
    for (const element of elements) {
      const name = element.localName.toLowerCase();
      if (
        element.namespaceURI !== "http://www.w3.org/2000/svg" ||
        element.prefix !== null
      ) {
        issues.push(issue("UNSAFE_SVG", "SVG elements must use the unprefixed SVG namespace"));
      }
      if (FORBIDDEN_SVG_ELEMENTS.has(name)) {
        issues.push(issue("UNSAFE_SVG", "SVG contains a forbidden active or resource element"));
      }
      for (const attribute of element.attributes) {
        const attributeName = attribute.name.toLowerCase();
        const localName = attribute.localName.toLowerCase();
        if (attributeName.startsWith("on") || localName.startsWith("on")) {
          issues.push(issue("UNSAFE_SVG", "SVG contains an event-handler attribute"));
        }
        if (localName === "href") {
          const reference = attribute.value;
          const targetId = reference.startsWith("#") ? reference.slice(1) : "";
          const target = elements.find(
            (candidate) => candidate.getAttribute("id") === targetId,
          );
          if (!reference.startsWith("#") || targetId.length === 0 || target === undefined) {
            issues.push(issue("UNSAFE_SVG", "SVG contains an external or unresolved reference"));
          }
        }
        if (["src", "srcset", "data", "poster", "xml:base"].includes(attributeName)) {
          issues.push(issue("UNSAFE_SVG", "SVG contains an external resource attribute"));
        }
        const inert =
          ["class", "id", "role"].includes(attributeName) ||
          attributeName.startsWith("aria-") ||
          attributeName.startsWith("data-") ||
          attributeName === "xmlns" ||
          attributeName.startsWith("xmlns:") ||
          localName === "href";
        if (!inert) {
          try {
            validateInlineSvgStyle(attribute.value);
          } catch {
            issues.push(issue("UNSAFE_SVG", "SVG attribute contains an unsafe resource value"));
          }
        }
      }
      if (name === "style") {
        try {
          validateInlineSvgStyle(element.textContent ?? "");
        } catch {
          issues.push(issue("UNSAFE_SVG", "SVG style contains an unsafe resource value"));
        }
      }
    }
  }
}

export function parseArtifactHtml(html) {
  let dom;
  try {
    dom = new JSDOM(html, { includeNodeLocations: true });
  } catch {
    failVerification([issue("INVALID_HTML", "Artifact HTML cannot be parsed")]);
  }
  return dom;
}

export function startupTimeout(value) {
  const timeout = value ?? DEFAULT_STARTUP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeout) || timeout < 10 || timeout > MAX_STARTUP_TIMEOUT_MS) {
    failVerification([
      issue("INVALID_VERIFICATION_OPTIONS", "Startup timeout must be an integer from 10 to 10000 milliseconds"),
    ]);
  }
  return timeout;
}

export function verifyArtifactStartup(html, options = undefined) {
  if (typeof html !== "string") {
    failVerification([issue("INVALID_HTML_INPUT", "Artifact HTML must be a string")]);
  }
  const inspected = inspectOptions(options, new Set(["timeoutMs"]));
  const timeoutMs = startupTimeout(inspected.timeoutMs);
  const result = spawnSync(
    process.execPath,
    ["--input-type=module", "--eval", STARTUP_PROGRAM],
    {
      encoding: "utf8",
      input: html,
      killSignal: "SIGKILL",
      maxBuffer: MAX_STARTUP_OUTPUT_BYTES,
      timeout: timeoutMs,
    },
  );

  if (result.error?.code === "ETIMEDOUT") {
    failVerification([
      issue("STARTUP_TIMEOUT", "Artifact startup exceeded the isolated execution timeout", {
        timeoutMs,
      }),
    ]);
  }
  if (result.error !== undefined || result.status !== 0) {
    failVerification([
      issue("STARTUP_PROCESS_FAILED", "Artifact startup isolation process failed"),
    ]);
  }

  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    failVerification([
      issue("STARTUP_PROCESS_FAILED", "Artifact startup isolation returned invalid output"),
    ]);
  }
  if (!Array.isArray(output.errors)) {
    failVerification([
      issue("STARTUP_PROCESS_FAILED", "Artifact startup isolation returned an invalid result"),
    ]);
  }
  if (output.errors.length > 0) {
    failVerification(
      output.errors.slice(0, 32).map((message) =>
        issue("STARTUP_ERROR", "Artifact emitted an uncaught startup error", {
          message: String(message).slice(0, 2_048),
        }),
      ),
    );
  }
  return { ok: true, issues: [] };
}
