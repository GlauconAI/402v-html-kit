export class ArtifactBuildError extends Error {
  #artifactDetails;
  #artifactMessage;

  constructor(code, message, details = undefined, options = undefined) {
    super(`${code}: ${message}`, options);
    this.name = "ArtifactBuildError";
    this.code = code;
    this.details = details;
    this.#artifactDetails = details;
    this.#artifactMessage = message;
  }

  toJSON() {
    const error = {
      code: this.code,
      message: this.#artifactMessage,
    };

    if (this.#artifactDetails !== undefined) {
      error.details = jsonSafeDetails(this.#artifactDetails);
    }

    return { ok: false, error };
  }
}

const MAX_DETAILS_DEPTH = 8;
const MAX_DETAILS_ENTRIES = 64;
const MAX_DETAILS_STRING_LENGTH = 2_048;

function boundedString(value) {
  if (value.length <= MAX_DETAILS_STRING_LENGTH) return value;
  return `${value.slice(0, MAX_DETAILS_STRING_LENGTH)}[Truncated]`;
}

function defineDetail(result, key, value) {
  Object.defineProperty(result, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

function detailKey(key) {
  return typeof key === "symbol" ? `[${String(key)}]` : key;
}

function jsonSafeDetails(value, depth = 0, ancestors = new Set()) {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return boundedString(value);
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    return Number.isFinite(value) ? value : String(value);
  }
  if (typeof value === "bigint" || typeof value === "symbol") return String(value);
  if (typeof value === "function") return "[function]";
  if (typeof value === "undefined") return "[undefined]";
  if (depth >= MAX_DETAILS_DEPTH) return "[MaxDepth]";
  if (ancestors.has(value)) return "[Circular]";

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = Number.isSafeInteger(lengthDescriptor?.value)
        ? Math.min(lengthDescriptor.value, MAX_DETAILS_ENTRIES)
        : 0;
      const result = [];
      for (let index = 0; index < length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (descriptor === undefined) {
          result.push("[Empty]");
        } else if ("get" in descriptor || "set" in descriptor) {
          result.push("[Accessor]");
        } else {
          result.push(jsonSafeDetails(descriptor.value, depth + 1, ancestors));
        }
      }
      if ((lengthDescriptor?.value ?? 0) > MAX_DETAILS_ENTRIES) {
        result.push("[Truncated]");
      }
      return result;
    }

    const result = {};
    const keys = Reflect.ownKeys(value)
      .map((key) => ({ key, label: detailKey(key) }))
      .sort((left, right) =>
        left.label < right.label ? -1 : left.label > right.label ? 1 : 0,
      );

    for (const { key, label } of keys.slice(0, MAX_DETAILS_ENTRIES)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      let normalized;
      if (descriptor === undefined) {
        normalized = "[Unavailable]";
      } else if ("get" in descriptor || "set" in descriptor) {
        normalized = "[Accessor]";
      } else {
        normalized = jsonSafeDetails(descriptor.value, depth + 1, ancestors);
      }

      let uniqueLabel = label;
      let duplicate = 2;
      while (Object.prototype.hasOwnProperty.call(result, uniqueLabel)) {
        uniqueLabel = `${label}#${duplicate}`;
        duplicate += 1;
      }
      defineDetail(result, uniqueLabel, normalized);
    }

    if (keys.length > MAX_DETAILS_ENTRIES) {
      defineDetail(result, "[Truncated]", keys.length - MAX_DETAILS_ENTRIES);
    }
    return result;
  } catch {
    return "[Unserializable]";
  } finally {
    ancestors.delete(value);
  }
}
