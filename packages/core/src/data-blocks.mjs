import { createHash } from "node:crypto";

import { JSDOM } from "jsdom";

import { ArtifactBuildError } from "./errors.mjs";

export const DATA_BLOCK_ID = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;

const APPLICATION_JSON_TYPE = /^application\/json$/i;
const INVALID_DATA_BLOCK = "INVALID_DATA_BLOCK";
const MAX_JSON_DEPTH = 256;

function invalid(message, details = undefined) {
  throw new ArtifactBuildError(INVALID_DATA_BLOCK, message, details);
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function consumeNodeBudget(nodeBudget, path) {
  if (nodeBudget === undefined) return;
  if (
    nodeBudget === null ||
    typeof nodeBudget !== "object" ||
    !Number.isSafeInteger(nodeBudget.remaining) ||
    nodeBudget.remaining < 0 ||
    !Number.isSafeInteger(nodeBudget.maximum) ||
    nodeBudget.maximum < 0
  ) {
    invalid("Data block canonicalization received an invalid node budget");
  }
  if (nodeBudget.remaining === 0) {
    invalid("Data blocks exceed the canonical JSON node budget", {
      maximumNodes: nodeBudget.maximum,
      path,
    });
  }
  nodeBudget.remaining -= 1;
}

function canonicalize(value, path, ancestors, depth, nodeBudget) {
  consumeNodeBudget(nodeBudget, path);
  if (depth > MAX_JSON_DEPTH) {
    invalid("Data block exceeds the maximum JSON depth", {
      maxDepth: MAX_JSON_DEPTH,
      path,
      reason: "maximum depth exceeded",
    });
  }

  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      invalid("Data block numbers must be finite", { path });
    }
    if (Object.is(value, -0)) {
      invalid("Data block numbers must preserve their JSON value", {
        path,
        reason: "negative zero",
      });
    }
    return value;
  }

  if (typeof value !== "object") {
    invalid("Data block contains a non-JSON value", {
      path,
      type: valueType(value),
    });
  }

  if (ancestors.has(value)) {
    invalid("Data block contains a cycle", { path });
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        invalid("Data block arrays must use Array.prototype", { path });
      }

      const allowedKeys = new Set(["length"]);
      const result = [];

      for (let index = 0; index < value.length; index += 1) {
        const key = String(index);
        allowedKeys.add(key);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined) {
          invalid("Data block arrays must not be sparse", { path, index });
        }
        if ("get" in descriptor || "set" in descriptor) {
          invalid("Data block arrays must not contain accessors", { path, index });
        }
        result.push(
          canonicalize(
            descriptor.value,
            `${path}[${index}]`,
            ancestors,
            depth + 1,
            nodeBudget,
          ),
        );
      }

      const extraKey = Reflect.ownKeys(value).find((key) => !allowedKeys.has(key));
      if (extraKey !== undefined) {
        invalid("Data block arrays must not have extra properties", {
          path,
          property: typeof extraKey === "symbol" ? extraKey.toString() : extraKey,
        });
      }

      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      invalid("Data block objects must use a plain-object prototype", { path });
    }

    const keys = Reflect.ownKeys(value);
    const symbolKey = keys.find((key) => typeof key === "symbol");
    if (symbolKey !== undefined) {
      invalid("Data block objects must not have symbol keys", {
        path,
        property: symbolKey.toString(),
      });
    }

    const result = {};
    for (const key of keys.sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable) {
        invalid("Data block objects must not have hidden properties", {
          path,
          property: key,
        });
      }
      if ("get" in descriptor || "set" in descriptor) {
        invalid("Data block objects must not contain accessors", {
          path,
          property: key,
        });
      }

      Object.defineProperty(result, key, {
        configurable: true,
        enumerable: true,
        value: canonicalize(
          descriptor.value,
          `${path}.${key}`,
          ancestors,
          depth + 1,
          nodeBudget,
        ),
        writable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

export function canonicalizeJson(value, options = undefined) {
  return canonicalize(value, "$", new Set(), 0, options?.nodeBudget);
}

const JSON_ESCAPE = {
  "<": "\\u003c",
  ">": "\\u003e",
  "&": "\\u0026",
  "\u2028": "\\u2028",
  "\u2029": "\\u2029",
};

export function stableJson(value) {
  return JSON.stringify(canonicalizeJson(value), null, 2).replace(
    /[<>&\u2028\u2029]/g,
    (character) => JSON_ESCAPE[character],
  );
}

function normalizedInvalidId(id) {
  if (typeof id === "string") return id;
  if (
    typeof id === "bigint" ||
    typeof id === "boolean" ||
    typeof id === "number" ||
    typeof id === "symbol"
  ) {
    return String(id);
  }
  if (typeof id === "undefined") return "undefined";
  if (typeof id === "function") return "[function]";
  return `[${valueType(id)}]`;
}

function validateId(id) {
  if (typeof id !== "string" || !DATA_BLOCK_ID.test(id)) {
    invalid("Data block id must match DATA_BLOCK_ID", { id: normalizedInvalidId(id) });
  }
}

function sortedEntries(blocks) {
  if (!(blocks instanceof Map)) {
    invalid("Data blocks must be provided as a Map");
  }

  const entries = [...blocks.entries()];
  for (const [id] of entries) validateId(id);
  return entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
}

function escapeHtmlAttribute(value) {
  return value.replace(/[&"'<>]/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      case "<":
        return "&lt;";
      default:
        return "&gt;";
    }
  });
}

export function serializeDataBlocks(blocks) {
  return sortedEntries(blocks)
    .map(
      ([id, value]) =>
        `<script type="application/json" id="${escapeHtmlAttribute(id)}">\n${stableJson(value)}\n</script>`,
    )
    .join("\n");
}

export function extractDataBlocks(html) {
  if (typeof html !== "string") {
    invalid("HTML containing data blocks must be a string");
  }

  let dom;
  try {
    dom = new JSDOM(html, {
      // jsdom 29.1.1 needs locations to keep noscript parsing scripting-enabled;
      // outside-only still prevents execution, and tests pin both behaviors.
      includeNodeLocations: true,
      runScripts: "outside-only",
    });
  } catch {
    invalid("Unable to parse HTML data blocks", {
      reason: "parser construction failed",
    });
  }

  try {
    const blocks = new Map();
    const elements = dom.window.document.querySelectorAll("script[id]");
    for (const element of elements) {
      const type = element.getAttribute("type");
      if (type === null || !APPLICATION_JSON_TYPE.test(type)) continue;

      const id = element.getAttribute("id");
      validateId(id);
      if (blocks.has(id)) {
        invalid("Duplicate data block id", { id });
      }

      let parsed;
      try {
        parsed = JSON.parse(element.textContent ?? "");
      } catch {
        invalid("Data block contains malformed JSON", { id });
      }
      blocks.set(id, canonicalizeJson(parsed));
    }
    return blocks;
  } finally {
    dom.window.close();
  }
}

export function computeSourceHash(blocks) {
  const hash = createHash("sha256");
  for (const [id, value] of sortedEntries(blocks)) {
    hash.update(id);
    hash.update("\0");
    hash.update(stableJson(value));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}
