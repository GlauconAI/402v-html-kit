import { validateInlineStylesheet } from "./assets.mjs";
import {
  canonicalizeJson,
  computeSourceHash,
  serializeDataBlocks,
  stableJson,
} from "./data-blocks.mjs";
import { sumUtf8TextBytes } from "./data-accounting-v2.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";
import { renderArtifactRuntimeV2 } from "./runtime-v2.mjs";
import { validClassicScript } from "./verify-common.mjs";
import { verifyArtifactHtml } from "./verify.mjs";

const THEME_ID = /^(?:[A-Za-z0-9][A-Za-z0-9._-]{0,127}|@[A-Za-z0-9][A-Za-z0-9._-]{0,62}\/[A-Za-z0-9][A-Za-z0-9._-]{0,62})$/;
const THEME_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const LANGUAGE = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const CORE_STYLE = ":where(html,body){max-width:100%;overflow-x:clip}:where([data-html-kit-root]){min-width:0;max-width:100%;overflow-wrap:anywhere}:where([data-html-kit-root] svg){max-width:100%;height:auto}";
const RAW_SCRIPT_MARKER = /<!--|<\/?script/i;

function fail(code, message, details = undefined) {
  throw new ArtifactBuildError(code, message, details);
}

function escapeHtml(value) {
  return value.replace(/[&<>]/g, (character) =>
    character === "&" ? "&amp;" : character === "<" ? "&lt;" : "&gt;",
  );
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function requireString(value, label, { nonEmpty = false } = {}) {
  if (typeof value !== "string" || (nonEmpty && value.trim().length === 0)) {
    fail("INVALID_ARTIFACT_INPUT", `${label} must be ${nonEmpty ? "a non-empty " : "a "}string`);
  }
  return value;
}

function requireRecord(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("INVALID_ARTIFACT_INPUT", `${label} must be an object`);
  }
  return value;
}

function normalizeDataBlocks(dataBlocks) {
  if (!(dataBlocks instanceof Map)) {
    fail("INVALID_DATA_BLOCK", "Artifact data blocks must be provided as a Map");
  }
  if (dataBlocks.size > ARTIFACT_RESOURCE_LIMITS.dataBlocks) {
    fail("RESOURCE_LIMIT_EXCEEDED", "Artifact has too many data blocks");
  }
  const nodeBudget = {
    maximum: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
    remaining: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
  };
  const normalized = new Map();
  for (const [id, value] of dataBlocks) {
    normalized.set(id, canonicalizeJson(value, { nodeBudget }));
  }
  const serialized = serializeDataBlocks(normalized);
  sumUtf8TextBytes(
    [...normalized.values()].map((value) => `\n${stableJson(value)}\n`),
    { maximumBytes: ARTIFACT_RESOURCE_LIMITS.rawJsonBytes },
  );
  return { normalized, serialized };
}

function normalizeConsumerScripts(value, mode) {
  if (!Array.isArray(value) || value.length > ARTIFACT_RESOURCE_LIMITS.scripts) {
    fail("INVALID_JAVASCRIPT", "Consumer scripts must be a bounded array");
  }
  if (mode === "note" && value.length > 0) {
    fail("INVALID_MODE", "Note artifacts must not declare consumer scripts");
  }
  let bytes = 0;
  return value.map((script) => {
    requireString(script, "Consumer script");
    bytes += Buffer.byteLength(script, "utf8");
    if (
      bytes > ARTIFACT_RESOURCE_LIMITS.scriptBytes ||
      RAW_SCRIPT_MARKER.test(script) ||
      !validClassicScript(script)
    ) {
      fail("INVALID_JAVASCRIPT", "Consumer script is not safe dependency-free classic JavaScript");
    }
    return script;
  });
}

export function assembleArtifactV2WithVerification(input) {
  requireRecord(input, "Artifact input");
  const mode = input.mode;
  if (mode !== "note" && mode !== "interactive") {
    fail("INVALID_MODE", "Artifact mode must be note or interactive");
  }

  const metadata = requireRecord(input.metadata, "Artifact metadata");
  const title = requireString(metadata.title, "Artifact title", { nonEmpty: true });
  const description = requireString(metadata.description, "Artifact description");
  const eyebrow = requireString(metadata.eyebrow, "Artifact eyebrow");
  const metadataLang = requireString(metadata.lang, "Artifact language", { nonEmpty: true });

  const theme = requireRecord(input.theme, "Artifact theme identity");
  const themeId = requireString(theme.id, "Theme ID", { nonEmpty: true });
  const themeVersion = requireString(theme.version, "Theme version", { nonEmpty: true });
  if (!THEME_ID.test(themeId) || !THEME_VERSION.test(themeVersion)) {
    fail("INVALID_THEME", "Theme ID or version metadata is invalid");
  }

  const themeOutput = requireRecord(input.themeOutput, "Theme output");
  const lang = requireString(themeOutput.lang, "Theme output language", { nonEmpty: true });
  const styles = requireString(themeOutput.styles, "Theme output styles");
  const bodyHtml = requireString(themeOutput.bodyHtml, "Theme output body HTML");
  if (lang !== metadataLang || !LANGUAGE.test(lang)) {
    fail("INVALID_ARTIFACT_INPUT", "Metadata and theme output must use one valid language tag");
  }
  if (
    Buffer.byteLength(styles, "utf8") > ARTIFACT_RESOURCE_LIMITS.stylesheetBytes ||
    /<\/style/i.test(styles)
  ) {
    fail("INVALID_STYLESHEET", "Theme stylesheet exceeds its limit or contains unsafe raw text");
  }
  validateInlineStylesheet(styles);

  const { normalized: dataBlocks, serialized: serializedData } = normalizeDataBlocks(
    input.dataBlocks,
  );
  const consumerScripts = normalizeConsumerScripts(input.consumerScripts, mode);
  const sourceHash = computeSourceHash(dataBlocks);
  const pieces = [
    "<!doctype html>",
    `<html lang="${escapeAttribute(lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="generator" content="402v HTML Kit">',
    '<meta name="html-kit-artifact-contract" content="2">',
    `<meta name="html-kit-artifact-mode" content="${mode}">`,
    `<meta name="html-kit-source-hash" content="${sourceHash}">`,
    `<meta name="html-kit-theme-id" content="${escapeAttribute(themeId)}">`,
    `<meta name="html-kit-theme-version" content="${escapeAttribute(themeVersion)}">`,
    `<meta name="description" content="${escapeAttribute(description)}">`,
    `<meta name="html-kit-eyebrow" content="${escapeAttribute(eyebrow)}">`,
    `<title>${escapeHtml(title)}</title>`,
  ];
  if (styles.length > 0) pieces.push(`<style data-html-kit-theme>\n${styles}\n</style>`);
  pieces.push(`<style data-html-kit-core>\n${CORE_STYLE}\n</style>`, "</head>", "<body>");
  pieces.push("<div data-html-kit-root>", bodyHtml, "</div>");
  if (serializedData.length > 0) pieces.push(serializedData);
  if (mode === "interactive") {
    pieces.push(renderArtifactRuntimeV2([...dataBlocks.keys()]));
    for (const script of consumerScripts) {
      pieces.push(`<script data-html-kit-consumer-script>\n${script}\n</script>`);
    }
  }
  pieces.push("</body>", "</html>");
  const html = `${pieces.join("\n")}\n`;
  if (Buffer.byteLength(html, "utf8") > ARTIFACT_RESOURCE_LIMITS.artifactBytes) {
    fail("RESOURCE_LIMIT_EXCEEDED", "Artifact exceeds the HTML byte limit");
  }
  const verification = verifyArtifactHtml(html);
  return { html, verification };
}

export function assembleArtifactV2(input) {
  return assembleArtifactV2WithVerification(input).html;
}
