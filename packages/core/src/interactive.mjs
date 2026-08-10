import { canonicalizeJson, DATA_BLOCK_ID } from "./data-blocks.mjs";
import { ArtifactBuildError } from "./errors.mjs";
import { getArtifactManifestInternals } from "./manifest.mjs";
import { ARTIFACT_RESOURCE_LIMITS } from "./resource-limits.mjs";

export const INTERACTIVE_SLOTS = Object.freeze([
  "navigation",
  "heroSupplementary",
  "mainSections",
  "rail",
  "footer",
]);

const SLOT_SET = new Set(INTERACTIVE_SLOTS);

function fail(code, message, details = undefined, options = undefined) {
  throw new ArtifactBuildError(code, message, details, options);
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor !== undefined && "value" in descriptor) {
      deepFreeze(descriptor.value);
    }
  }
  return value;
}

function rendererData(data) {
  const result = Object.create(null);
  for (const [id, value] of data) {
    Object.defineProperty(result, id, {
      configurable: false,
      enumerable: true,
      value: canonicalizeJson(value),
      writable: false,
    });
  }
  return deepFreeze(result);
}

function rendererSvg(assets) {
  const result = Object.create(null);
  for (const asset of assets) {
    Object.defineProperty(result, asset.id, {
      configurable: false,
      enumerable: true,
      value: deepFreeze({ ...asset }),
      writable: false,
    });
  }
  return deepFreeze(result);
}

function invalidDataInput(message, options = undefined) {
  fail("INVALID_DATA_BLOCK", message, undefined, options);
}

function inspectRenderOptions(options) {
  if (options === undefined) return undefined;
  if (options === null || typeof options !== "object") {
    invalidDataInput("render options must be a plain object");
  }

  let array;
  let descriptors;
  let keys;
  let prototype;
  try {
    array = Array.isArray(options);
    prototype = Object.getPrototypeOf(options);
    descriptors = Object.getOwnPropertyDescriptors(options);
    keys = Reflect.ownKeys(options);
  } catch (cause) {
    invalidDataInput("render options cannot be inspected safely", { cause });
  }
  if (
    array ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    invalidDataInput("render options must be a plain object");
  }

  for (const key of keys) {
    if (key !== "preservedData") {
      invalidDataInput("render options contain an unknown property");
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      "get" in descriptor ||
      "set" in descriptor
    ) {
      invalidDataInput(
        "render options must contain only enumerable data properties",
      );
    }
  }
  return descriptors.preservedData?.value;
}

function canonicalPreservedData(value, nodeBudget) {
  if (value === undefined) return new Map();
  if (value === null || typeof value !== "object") {
    invalidDataInput("preservedData must be a Map");
  }
  let prototype;
  try {
    prototype = Object.getPrototypeOf(value);
  } catch (cause) {
    invalidDataInput("preservedData cannot be inspected safely", { cause });
  }
  if (prototype !== Map.prototype) {
    invalidDataInput("preservedData must be a Map");
  }

  const result = new Map();
  try {
    for (const [id, data] of Map.prototype.entries.call(value)) {
      if (typeof id !== "string" || !DATA_BLOCK_ID.test(id)) {
        fail(
          "INVALID_DATA_BLOCK",
          "Preserved data block id must match DATA_BLOCK_ID",
        );
      }
      result.set(id, canonicalizeJson(data, { nodeBudget }));
    }
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) throw cause;
    invalidDataInput("preservedData cannot be read safely", { cause });
  }
  return result;
}

function inspectLoadedManifest(manifest) {
  if (manifest === null || typeof manifest !== "object") {
    fail("INVALID_MANIFEST", "Expected a loaded contract-version-2 manifest");
  }

  let array;
  let descriptors;
  let internals;
  let prototype;
  try {
    internals = getArtifactManifestInternals(manifest);
    array = Array.isArray(manifest);
    prototype = Object.getPrototypeOf(manifest);
    descriptors = Object.getOwnPropertyDescriptors(manifest);
  } catch (cause) {
    fail(
      "INVALID_MANIFEST",
      "Loaded manifest cannot be inspected safely",
      undefined,
      { cause },
    );
  }
  if (
    array ||
    (prototype !== Object.prototype && prototype !== null)
  ) {
    fail("INVALID_MANIFEST", "Expected a loaded contract-version-2 manifest");
  }

  const contract = descriptors.contractVersion;
  const mode = descriptors.mode;
  const metadata = descriptors.metadata;
  const requiredDataBlocks = descriptors.requiredDataBlocks;
  for (const descriptor of [contract, mode, metadata, requiredDataBlocks]) {
    if (descriptor === undefined || "get" in descriptor || "set" in descriptor) {
      fail("INVALID_MANIFEST", "Expected a loaded contract-version-2 manifest");
    }
  }
  if (
    contract.value !== 2 ||
    mode.value !== "interactive" ||
    internals === null ||
    typeof internals !== "object"
  ) {
    fail("INVALID_MANIFEST", "Expected a loaded contract-version-2 manifest");
  }
  let internalDescriptors;
  let internalKeys;
  let internalPrototype;
  try {
    internalPrototype = Object.getPrototypeOf(internals);
    internalDescriptors = Object.getOwnPropertyDescriptors(internals);
    internalKeys = Reflect.ownKeys(internals);
  } catch (cause) {
    fail(
      "INVALID_MANIFEST",
      "Loaded manifest internals cannot be inspected safely",
      undefined,
      { cause },
    );
  }
  const methods = [
    "loadData",
    "loadStyles",
    "loadScripts",
    "loadSvg",
    "importRenderer",
  ];
  if (
    internalPrototype !== Object.prototype ||
    internalKeys.length !== methods.length ||
    internalKeys.some((key) => typeof key !== "string" || !methods.includes(key))
  ) {
    fail("INVALID_MANIFEST", "Loaded manifest internals are invalid");
  }
  const safeInternals = {};
  for (const method of methods) {
    const descriptor = internalDescriptors[method];
    if (
      descriptor === undefined ||
      "get" in descriptor ||
      "set" in descriptor ||
      typeof descriptor.value !== "function"
    ) {
      fail("INVALID_MANIFEST", "Loaded manifest internals are invalid");
    }
    safeInternals[method] = descriptor.value;
  }
  return {
    internals: Object.freeze(safeInternals),
    metadata: metadata.value,
    requiredDataBlocks: requiredDataBlocks.value,
  };
}

function invokeInternal(internals, method, code, message, ...args) {
  try {
    return internals[method](...args);
  } catch (cause) {
    if (cause instanceof ArtifactBuildError) throw cause;
    fail(code, message, undefined, { cause });
  }
}

function sortedData(data) {
  return new Map(
    [...data.entries()].sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    ),
  );
}

function validateRendererResult(value) {
  if (value === null || typeof value !== "object") {
    fail("INVALID_RENDERER_RESULT", "renderArtifact must return a plain object");
  }

  let array;
  let descriptors;
  let keys;
  let prototype;
  try {
    array = Array.isArray(value);
    prototype = Object.getPrototypeOf(value);
    descriptors = Object.getOwnPropertyDescriptors(value);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(
      "INVALID_RENDERER_RESULT",
      "Renderer result cannot be inspected safely",
    );
  }
  if (array) {
    fail("INVALID_RENDERER_RESULT", "renderArtifact must return a plain object");
  }
  if (prototype !== Object.prototype && prototype !== null) {
    fail("INVALID_RENDERER_RESULT", "renderArtifact must return a plain object");
  }

  for (const key of keys) {
    const printableKey = typeof key === "symbol" ? key.toString() : String(key);
    if (typeof key !== "string" || !SLOT_SET.has(key)) {
      fail("INVALID_RENDERER_RESULT", "Renderer returned an unknown slot", {
        slot: printableKey,
      });
    }
    const descriptor = descriptors[key];
    if (
      descriptor === undefined ||
      !descriptor.enumerable ||
      "get" in descriptor ||
      "set" in descriptor ||
      typeof descriptor.value !== "string"
    ) {
      fail("INVALID_RENDERER_RESULT", "Renderer slots must be enumerable strings", {
        slot: printableKey,
      });
    }
  }

  const slots = {};
  for (const slot of INTERACTIVE_SLOTS) {
    if (descriptors[slot] !== undefined) slots[slot] = descriptors[slot].value;
  }
  return slots;
}

export async function renderInteractiveModel(manifest, options = undefined) {
  const loadedManifest = inspectLoadedManifest(manifest);
  const { internals } = loadedManifest;
  const nodeBudget = {
    maximum: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
    remaining: ARTIFACT_RESOURCE_LIMITS.canonicalJsonNodes,
  };

  const data = invokeInternal(
    internals,
    "loadData",
    "INVALID_DATA_BLOCK",
    "Unable to load manifest data",
    nodeBudget,
  );
  for (const [id, value] of canonicalPreservedData(
    inspectRenderOptions(options),
    nodeBudget,
  )) {
    data.set(id, value);
  }
  const normalizedData = sortedData(data);
  const styles = invokeInternal(
    internals,
    "loadStyles",
    "INVALID_STYLESHEET",
    "Unable to load manifest styles",
  );
  const scripts = invokeInternal(
    internals,
    "loadScripts",
    "INVALID_JAVASCRIPT",
    "Unable to load manifest scripts",
  );
  const svg = invokeInternal(
    internals,
    "loadSvg",
    "UNSAFE_SVG",
    "Unable to load manifest SVG assets",
  );

  let namespace;
  try {
    namespace = await internals.importRenderer();
  } catch {
    fail(
      "INVALID_RENDERER_RESULT",
      "Unable to import renderer",
    );
  }
  if (typeof namespace.renderArtifact !== "function") {
    fail(
      "INVALID_RENDERER_RESULT",
      "Renderer must export a renderArtifact function",
    );
  }

  let rendered;
  try {
    rendered = await namespace.renderArtifact({
      data: rendererData(normalizedData),
      svg: rendererSvg(svg),
      metadata: deepFreeze({ ...loadedManifest.metadata }),
    });
  } catch {
    fail(
      "INVALID_RENDERER_RESULT",
      "renderArtifact execution failed",
    );
  }

  return {
    metadata: { ...loadedManifest.metadata },
    data: normalizedData,
    slots: validateRendererResult(rendered),
    styles,
    scripts,
    svg,
    requiredDataBlocks: [...loadedManifest.requiredDataBlocks],
  };
}
