import { ArtifactBuildError } from "./errors.mjs";
import { findMetaElements } from "./meta.mjs";
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
const GENERATOR = "402v HTML Note Kit";
const APPLICATION_JSON = /^application\/json$/i;

function verifyNoteBaseline(document, issues) {
  const hasInlineStyles = [...document.querySelectorAll("style")].some(
    (style) => (style.textContent ?? "").trim().length > 0,
  );
  if (!hasInlineStyles) {
    issues.push(issue("MISSING_INLINE_STYLESHEET", "Note artifact requires an inline stylesheet"));
  }
  const article = document.querySelector("article.note-article");
  if (article === null || article.innerHTML.length === 0) {
    issues.push(issue("MISSING_NOTE_CONTENT", "Note artifact requires article content"));
  }
}

function verifyScripts(document, dataNodes, mode, issues) {
  const allScripts = [...document.querySelectorAll("script")];
  const runtime = allScripts.filter((script) => script.hasAttribute("data-402v-runtime"));
  const clients = allScripts.filter((script) => script.hasAttribute("data-artifact-script"));
  const executable = allScripts.filter((script) => {
    const type = script.getAttribute("type");
    return type === null || !APPLICATION_JSON.test(type);
  });

  if (mode === "interactive" && runtime.length !== 1) {
    issues.push(issue("MISSING_RUNTIME", "Interactive artifact requires exactly one inline runtime"));
  }
  if (mode === "note" && executable.length > 0) {
    issues.push(issue("INVALID_MODE", "Note artifacts must not contain executable scripts"));
  }
  for (const script of executable) {
    if (
      !script.hasAttribute("data-402v-runtime") &&
      !script.hasAttribute("data-artifact-script")
    ) {
      issues.push(issue("UNDECLARED_SCRIPT", "Executable scripts must be declared runtime or client entries"));
    }
  }
  for (const script of [...runtime, ...clients]) {
    if (
      !hasClassicScriptType(script) ||
      !validClassicScript(script.textContent ?? "")
    ) {
      issues.push(issue("INVALID_JAVASCRIPT", "Inline artifact entry is not valid dependency-free classic JavaScript"));
    }
  }

  if (mode === "interactive" && runtime.length === 1) {
    const runtimeIndex = allScripts.indexOf(runtime[0]);
    const dataAfterRuntime = dataNodes.some(
      (script) => allScripts.indexOf(script) > runtimeIndex,
    );
    const clientBeforeRuntime = clients.some(
      (script) => allScripts.indexOf(script) < runtimeIndex,
    );
    if (dataAfterRuntime || clientBeforeRuntime) {
      issues.push(issue("INVALID_SCRIPT_ORDER", "Canonical data, runtime, and client entries are out of order"));
    }
  }
}

function hasImportantStyle(element, declarations) {
  return (
    element !== null &&
    element !== undefined &&
    declarations.every(
      ([property, value]) =>
        element.style.getPropertyValue(property) === value &&
        element.style.getPropertyPriority(property) === "important",
    )
  );
}

function hasOverflowGuards(document) {
  const pageDeclarations = [
    ["max-width", "100%"],
    ["overflow-x", "clip"],
  ];
  const layoutDeclarations = [
    ["min-width", "0px"],
    ["max-width", "100%"],
  ];
  const frameDeclarations = [
    ["max-width", "100%"],
    ["overflow-x", "auto"],
  ];
  const root = document.querySelector("[data-artifact-root]");
  const topbarInner = root?.querySelector(":scope > .artifact-topbar > .artifact-topbar-inner");
  const shell = root?.querySelector(":scope > .artifact-shell");
  const layout = shell?.querySelector(":scope > .artifact-layout");
  const main = layout?.querySelector(":scope > .artifact-main-panel");
  const rail = layout?.querySelector(":scope > .artifact-rail");
  return (
    hasImportantStyle(document.documentElement, pageDeclarations) &&
    hasImportantStyle(document.body, pageDeclarations) &&
    [root, topbarInner, shell, layout, main, rail].every((element) =>
      hasImportantStyle(element, layoutDeclarations),
    ) &&
    [...document.querySelectorAll(".artifact-svg-frame")].every((element) =>
      hasImportantStyle(element, frameDeclarations),
    )
  );
}

export function verifyArtifactV1Html(html, options = undefined) {
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
    if (document.head.querySelectorAll("title").length !== 1 || !document.title.trim()) {
      issues.push(issue("INVALID_TITLE", "Artifact requires exactly one non-empty title"));
    }
    addUniqueMetaIssue(issues, document, "viewport", VIEWPORT, "INVALID_VIEWPORT", "viewport metadata");
    addUniqueMetaIssue(issues, document, "generator", GENERATOR, "INVALID_GENERATOR", "generator metadata");

    const modeMetas = findMetaElements(document, "402v-artifact-mode");
    let mode;
    if (modeMetas.length === 1 && modeMetas[0].getAttribute("content") === "interactive") {
      mode = "interactive";
    } else if (modeMetas.length === 0 && document.querySelector(".note-article") !== null) {
      mode = "note";
    } else {
      mode = "unknown";
      issues.push(issue("INVALID_MODE", "Artifact mode must be note or interactive"));
    }

    if (mode === "note") verifyNoteBaseline(document, issues);
    verifyResources(document, issues, mode);
    const data = verifyData(
      document,
      html,
      (node) => dom.nodeLocation(node),
      required,
      mode,
      issues,
    );
    verifyScripts(document, data.nodes, mode, issues);
    if (mode === "interactive") verifySvg(document, issues);
    if (mode === "interactive" && !hasOverflowGuards(document)) {
      issues.push(issue("MISSING_OVERFLOW_GUARD", "Interactive artifact lacks required page and SVG overflow guards"));
    }
    if (mode === "interactive" && document.querySelectorAll("[data-artifact-root]").length !== 1) {
      issues.push(issue("INVALID_ARTIFACT_ROOT", "Interactive artifact requires exactly one root element"));
    }

    if (issues.length === 0 && mode === "interactive") {
      try {
        verifyArtifactStartup(html, { timeoutMs });
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
      contractVersion: 1,
      mode,
      sourceHash: data.sourceHash,
      dataBlockIds: [...data.blocks.keys()].sort(),
      issues: [],
    };
  } finally {
    dom.window.close();
  }
}
