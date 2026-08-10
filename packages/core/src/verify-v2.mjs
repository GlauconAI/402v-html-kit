import { ArtifactBuildError } from "./errors.mjs";
import { canonicalizeJson } from "./data-blocks.mjs";
import { sumUtf8TextBytes } from "./data-accounting-v2.mjs";
import { findMetaElements } from "./meta.mjs";
import { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";
import {
  addUniqueMetaIssue,
  failVerification,
  hasClassicScriptType,
  inspectOptions,
  issue,
  parseArtifactHtml,
  requiredDataBlocks,
  startupTimeout,
  validClassicScript,
  verifyArtifactStartup,
  verifyData,
  verifyResources,
  verifySvg,
} from "./verify-common.mjs";

const VIEWPORT = "width=device-width, initial-scale=1";
const GENERATOR = "402v HTML Kit";
const APPLICATION_JSON = /^application\/json$/i;
const THEME_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,62})$/;
const THEME_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const REQUIRED_CORE_STYLE = ":where(html,body){max-width:100%;overflow-x:clip}:where([data-html-kit-root]){min-width:0;max-width:100%;overflow-wrap:anywhere}:where([data-html-kit-root] svg){max-width:100%;height:auto}";
const PASSIVE_NAVIGATION_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const NETWORK_SIDE_EFFECT_ATTRIBUTES = new Set(["action", "formaction", "ping"]);

function addUniqueMetaValueIssue(issues, document, name, code, label, predicate) {
  const matches = findMetaElements(document, name);
  const value = matches[0]?.getAttribute("content");
  if (matches.length !== 1 || typeof value !== "string" || !predicate(value)) {
    issues.push(issue(code, `Artifact requires exactly one valid ${label}`));
  }
  return value;
}

function verifyLimits(html, document, data, issues) {
  if (Buffer.byteLength(html, "utf8") > ARTIFACT_RESOURCE_LIMITS.artifactBytes) {
    issues.push(issue("RESOURCE_LIMIT_EXCEEDED", "Artifact exceeds the HTML byte limit"));
  }
  if (data.nodes.length > ARTIFACT_RESOURCE_LIMITS.dataBlocks) {
    issues.push(issue("RESOURCE_LIMIT_EXCEEDED", "Artifact has too many data blocks"));
  }
  try {
    sumUtf8TextBytes(
      data.nodes.map((node) => node.textContent ?? ""),
      { maximumBytes: ARTIFACT_RESOURCE_LIMITS.rawJsonBytes },
    );
  } catch {
    issues.push(issue("RESOURCE_LIMIT_EXCEEDED", "Artifact data exceeds the JSON byte limit"));
  }
  const nodeBudget = {
    maximum: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
    remaining: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
  };
  try {
    for (const value of data.blocks.values()) canonicalizeJson(value, { nodeBudget });
  } catch {
    issues.push(issue("RESOURCE_LIMIT_EXCEEDED", "Artifact data exceeds the canonical JSON node limit"));
  }
  const styles = [...document.querySelectorAll("style")];
  const styleBytes = styles.reduce(
    (total, node) => total + Buffer.byteLength(node.textContent ?? "", "utf8"),
    0,
  );
  if (
    styles.length > ARTIFACT_RESOURCE_LIMITS.styles ||
    styleBytes > ARTIFACT_RESOURCE_LIMITS.stylesheetBytes
  ) {
    issues.push(issue("RESOURCE_LIMIT_EXCEEDED", "Artifact styles exceed resource limits"));
  }
  const svgs = [...document.querySelectorAll("svg")];
  const svgBytes = svgs.reduce(
    (total, node) => total + Buffer.byteLength(node.outerHTML, "utf8"),
    0,
  );
  if (
    svgs.length > ARTIFACT_RESOURCE_LIMITS.svgAssets ||
    svgBytes > ARTIFACT_RESOURCE_LIMITS.svgBytes
  ) {
    issues.push(issue("RESOURCE_LIMIT_EXCEEDED", "Artifact SVG content exceeds resource limits"));
  }
}

function verifyScripts(document, dataNodes, mode, issues) {
  const allScripts = [...document.querySelectorAll("script")];
  const runtime = allScripts.filter((script) => script.hasAttribute("data-html-kit-runtime"));
  const consumers = allScripts.filter((script) =>
    script.hasAttribute("data-html-kit-consumer-script"),
  );
  const executable = allScripts.filter((script) => {
    const type = script.getAttribute("type");
    return type === null || !APPLICATION_JSON.test(type);
  });

  if (mode === "interactive" && runtime.length !== 1) {
    issues.push(issue("MISSING_RUNTIME", "Interactive artifact requires exactly one inline runtime"));
  }
  if (mode === "note" && (runtime.length > 0 || executable.length > 0)) {
    issues.push(issue("INVALID_MODE", "Note artifacts must not contain executable scripts"));
  }
  if (consumers.length > ARTIFACT_RESOURCE_LIMITS.scripts) {
    issues.push(issue("RESOURCE_LIMIT_EXCEEDED", "Artifact has too many consumer scripts"));
  }
  const scriptBytes = [...runtime, ...consumers].reduce(
    (total, script) => total + Buffer.byteLength(script.textContent ?? "", "utf8"),
    0,
  );
  if (scriptBytes > ARTIFACT_RESOURCE_LIMITS.scriptBytes) {
    issues.push(issue("RESOURCE_LIMIT_EXCEEDED", "Artifact scripts exceed the script byte limit"));
  }
  for (const script of executable) {
    const isRuntime = script.hasAttribute("data-html-kit-runtime");
    const isConsumer = script.hasAttribute("data-html-kit-consumer-script");
    if (isRuntime === isConsumer) {
      issues.push(issue("UNDECLARED_SCRIPT", "Executable scripts must declare exactly one runtime or consumer role"));
    }
  }
  for (const script of [...runtime, ...consumers]) {
    if (
      !executable.includes(script) ||
      !hasClassicScriptType(script) ||
      !validClassicScript(script.textContent ?? "")
    ) {
      issues.push(issue("INVALID_JAVASCRIPT", "Inline artifact entry is not valid dependency-free classic JavaScript"));
    }
  }

  const dataIds = dataNodes.map((node) => node.getAttribute("id") ?? "");
  if (dataIds.some((id, index) => index > 0 && dataIds[index - 1] > id)) {
    issues.push(issue("INVALID_SCRIPT_ORDER", "Canonical data blocks must be ordered by ID"));
  }
  if (mode === "interactive" && runtime.length === 1) {
    const runtimeIndex = allScripts.indexOf(runtime[0]);
    const dataAfterRuntime = dataNodes.some(
      (script) => allScripts.indexOf(script) > runtimeIndex,
    );
    const consumerBeforeRuntime = consumers.some(
      (script) => allScripts.indexOf(script) < runtimeIndex,
    );
    if (dataAfterRuntime || consumerBeforeRuntime) {
      issues.push(issue("INVALID_SCRIPT_ORDER", "Canonical data, runtime, and consumer entries are out of order"));
    }
  }
}

function verifyDocumentStructure(document, dataNodes, mode, issues) {
  const root = document.querySelector("[data-html-kit-root]");
  if (root?.parentElement !== document.body) {
    issues.push(issue("INVALID_DOCUMENT_STRUCTURE", "Artifact root must be a direct body child"));
  }
  const protocolScripts = [
    ...dataNodes,
    ...document.querySelectorAll("script[data-html-kit-runtime]"),
    ...document.querySelectorAll("script[data-html-kit-consumer-script]"),
  ];
  if (protocolScripts.some((script) => script.parentElement !== document.body)) {
    issues.push(issue("INVALID_DOCUMENT_STRUCTURE", "Artifact protocol scripts must be direct body children"));
  }
  const runtime = [...document.querySelectorAll("script[data-html-kit-runtime]")];
  const consumers = [
    ...document.querySelectorAll("script[data-html-kit-consumer-script]"),
  ];
  const expected = [root, ...dataNodes];
  if (mode === "interactive") expected.push(...runtime, ...consumers);
  const actual = [...document.body.children];
  if (
    actual.length !== expected.length ||
    actual.some((element, index) => element !== expected[index])
  ) {
    issues.push(issue("INVALID_DOCUMENT_STRUCTURE", "Artifact body elements are out of canonical order"));
  }
  if (
    [...document.body.childNodes].some(
      (node) => node.nodeType !== 1 && (node.nodeType !== 3 || (node.textContent ?? "").trim()),
    )
  ) {
    issues.push(issue("INVALID_DOCUMENT_STRUCTURE", "Artifact body contains non-element content outside the owned root"));
  }
}

function asciiLowercase(value) {
  return value.replace(/[A-Z]/g, (character) =>
    String.fromCharCode(character.charCodeAt(0) + 0x20),
  );
}

function verifyEventHandlerAttributes(document, issues) {
  for (const element of document.querySelectorAll("*")) {
    for (const attribute of element.attributes) {
      if (asciiLowercase(attribute.name).startsWith("on")) {
        issues.push(
          issue(
            "UNSAFE_JAVASCRIPT",
            "Artifact elements must not contain event-handler attributes",
          ),
        );
      }
    }
  }
}

function normalizedUrlScheme(value) {
  const colon = value.indexOf(":");
  if (colon < 0) return undefined;
  const candidate = asciiLowercase(value.slice(0, colon)).replace(
    /[\u0000-\u0020\u007f]/g,
    "",
  );
  return /^[a-z][a-z0-9+.-]*$/.test(candidate) ? candidate : undefined;
}

function verifyActiveUrls(document, issues) {
  for (const element of document.querySelectorAll("*")) {
    if (
      element.localName.toLowerCase() === "meta" &&
      asciiLowercase(element.getAttribute("http-equiv") ?? "").trim() === "refresh"
    ) {
      issues.push(issue("UNSAFE_URL", "Artifact must not contain meta refresh navigation"));
    }
    for (const attribute of element.attributes) {
      const name = asciiLowercase(attribute.name);
      if (NETWORK_SIDE_EFFECT_ATTRIBUTES.has(name) || name === "background") {
        issues.push(issue("UNSAFE_URL", "Artifact contains a network side-effect attribute"));
        continue;
      }
      if (name === "href" || name === "xlink:href") {
        const scheme = normalizedUrlScheme(attribute.value);
        if (scheme !== undefined && !PASSIVE_NAVIGATION_SCHEMES.has(scheme)) {
          issues.push(issue("UNSAFE_URL", "Artifact contains an unsafe navigation URL"));
        }
      }
    }
  }
}

export function verifyArtifactV2Html(html, options = undefined) {
  if (typeof html !== "string") {
    failVerification([issue("INVALID_HTML_INPUT", "Artifact HTML must be a string")]);
  }
  const inspected = inspectOptions(
    options,
    new Set(["requiredDataBlocks", "startupTimeoutMs"]),
  );
  const required = requiredDataBlocks(inspected.requiredDataBlocks);
  const timeoutMs = startupTimeout(inspected.startupTimeoutMs);
  const issues = [];
  const dom = parseArtifactHtml(html);

  try {
    const { document } = dom.window;
    if (
      document.doctype?.name.toLowerCase() !== "html" ||
      document.doctype.publicId !== "" ||
      document.doctype.systemId !== ""
    ) {
      issues.push(issue("INVALID_DOCTYPE", "Artifact requires a plain HTML doctype"));
    }
    if (document.head.querySelectorAll(":scope > title").length !== 1 || !document.title.trim()) {
      issues.push(issue("INVALID_TITLE", "Artifact requires exactly one non-empty title"));
    }
    addUniqueMetaIssue(issues, document, "html-kit-artifact-contract", "2", "INVALID_CONTRACT", "contract metadata");
    const mode = addUniqueMetaValueIssue(
      issues,
      document,
      "html-kit-artifact-mode",
      "INVALID_MODE",
      "artifact mode metadata",
      (value) => value === "note" || value === "interactive",
    );
    addUniqueMetaIssue(issues, document, "viewport", VIEWPORT, "INVALID_VIEWPORT", "viewport metadata");
    addUniqueMetaIssue(issues, document, "generator", GENERATOR, "INVALID_GENERATOR", "generator metadata");
    addUniqueMetaValueIssue(issues, document, "description", "INVALID_METADATA", "description metadata", () => true);
    addUniqueMetaValueIssue(issues, document, "html-kit-eyebrow", "INVALID_METADATA", "eyebrow metadata", () => true);
    addUniqueMetaValueIssue(issues, document, "html-kit-theme-id", "INVALID_THEME", "theme ID metadata", (value) => THEME_ID.test(value));
    addUniqueMetaValueIssue(issues, document, "html-kit-theme-version", "INVALID_THEME", "theme version metadata", (value) => THEME_VERSION.test(value));
    if (!LANGUAGE.test(document.documentElement.getAttribute("lang") ?? "")) {
      issues.push(issue("INVALID_METADATA", "Artifact requires one valid document language"));
    }

    verifyResources(document, issues, mode, { strictOffline: true });
    verifyEventHandlerAttributes(document, issues);
    verifyActiveUrls(document, issues);
    const data = verifyData(
      document,
      html,
      (node) => dom.nodeLocation(node),
      required,
      mode,
      issues,
      {
        allowDataInNote: true,
        hashInNote: true,
        hashMetaName: "html-kit-source-hash",
      },
    );
    verifyLimits(html, document, data, issues);
    verifyScripts(document, data.nodes, mode, issues);
    verifyDocumentStructure(document, data.nodes, mode, issues);
    verifySvg(document, issues, { requireFrame: false });

    if (document.querySelectorAll("[data-html-kit-root]").length !== 1) {
      issues.push(issue("INVALID_ARTIFACT_ROOT", "Artifact requires exactly one root element"));
    }
    const coreStyles = [...document.querySelectorAll("style[data-html-kit-core]")];
    if (
      coreStyles.length !== 1 ||
      (coreStyles[0].textContent ?? "").trim() !== REQUIRED_CORE_STYLE
    ) {
      issues.push(issue("MISSING_OVERFLOW_GUARD", "Artifact lacks the neutral core overflow guard"));
    }

    if (issues.length === 0 && mode === "interactive") {
      try {
        verifyArtifactStartup(html, {
          timeoutMs,
          modeMetaName: "html-kit-artifact-mode",
          globalName: "__htmlKitArtifact",
          rootSelector: "[data-html-kit-root]",
          lockGlobal: true,
        });
      } catch (cause) {
        if (cause instanceof ArtifactBuildError) {
          const startupIssues = cause.details?.issues;
          if (Array.isArray(startupIssues)) issues.push(...startupIssues);
          else issues.push(issue("STARTUP_PROCESS_FAILED", "Artifact startup verification failed"));
        } else {
          issues.push(issue("STARTUP_PROCESS_FAILED", "Artifact startup verification failed"));
        }
      }
    }
    if (issues.length > 0) failVerification(issues);
    return {
      ok: true,
      contractVersion: 2,
      mode,
      sourceHash: data.sourceHash,
      dataBlockIds: [...data.blocks.keys()].sort(),
      issues: [],
    };
  } finally {
    dom.window.close();
  }
}
