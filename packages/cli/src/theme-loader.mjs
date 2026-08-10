import { realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ArtifactBuildError } from "@402v/html-kit-core";

const OFFICIAL_THEME = "@402v/theme-402v";
const MAX_THEME_SPECIFIER_BYTES = 256;
const MAX_BASE_DIRECTORY_BYTES = 4_096;
const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** @param {{ flag?: string, manifest?: string }} selection */
export function resolveThemeSelection({ flag, manifest }) {
  return flag || manifest || "@402v/theme-402v";
}

function fail(message) {
  throw new ArtifactBuildError("THEME_RESOLUTION_FAILED", message);
}

function boundedString(value, maximumBytes, label) {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    value.includes("\0") ||
    Buffer.byteLength(value, "utf8") > maximumBytes
  ) {
    fail(`${label} must be a bounded non-empty local string`);
  }
  return value;
}

function identity(path, label, expectedType) {
  let stats;
  try {
    stats = statSync(path, { bigint: true });
  } catch {
    fail(`${label} could not be inspected`);
  }
  if (!stats[expectedType]()) fail(`${label} has an unsupported filesystem type`);
  return Object.freeze({ dev: stats.dev, ino: stats.ino });
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function contained(root, candidate) {
  const difference = relative(root, candidate);
  return (
    difference === "" ||
    (!isAbsolute(difference) &&
      difference !== ".." &&
      !difference.startsWith(`..${sep}`))
  );
}

function localSpecifier(value) {
  return (
    isAbsolute(value) ||
    value === "." ||
    value === ".." ||
    value.startsWith(`.${sep}`) ||
    value.startsWith(`..${sep}`) ||
    value.startsWith("./") ||
    value.startsWith("../")
  );
}

function canonicalDirectory(input) {
  const requested = resolve(
    boundedString(input, MAX_BASE_DIRECTORY_BYTES, "Theme base directory"),
  );
  let canonical;
  try {
    canonical = realpathSync(requested);
  } catch {
    fail("Theme base directory could not be resolved");
  }
  return Object.freeze({
    requested,
    canonical,
    identity: identity(canonical, "Theme base directory", "isDirectory"),
  });
}

function resolveThemeModule(specifier, base) {
  let path;
  if (localSpecifier(specifier)) {
    let canonical;
    try {
      canonical = realpathSync(resolve(base.canonical, specifier));
    } catch {
      fail("Local theme module could not be resolved");
    }
    if (!contained(base.canonical, canonical)) {
      fail("Local theme module must remain inside the selected directory");
    }
    path = canonical;
  } else {
    try {
      const require = createRequire(join(base.canonical, "package.json"));
      if (require.resolve.paths(specifier) === null) {
        fail("Installed theme package could not be resolved");
      }
      path = realpathSync(
        fileURLToPath(
          import.meta.resolve(
            specifier,
            pathToFileURL(join(base.canonical, "package.json")).href,
          ),
        ),
      );
    } catch {
      if (specifier !== OFFICIAL_THEME) {
        fail("Installed theme package could not be resolved");
      }
      try {
        const require = createRequire(import.meta.url);
        if (require.resolve.paths(specifier) === null) {
          fail("Installed theme package could not be resolved");
        }
        path = realpathSync(
          fileURLToPath(import.meta.resolve(specifier, import.meta.url)),
        );
      } catch {
        fail("Installed theme package could not be resolved");
      }
    }
  }
  return Object.freeze({
    path,
    identity: identity(path, "Theme module", "isFile"),
  });
}

function revalidate(base, module) {
  let canonicalBase;
  let canonicalModule;
  try {
    canonicalBase = realpathSync(base.requested);
    canonicalModule = realpathSync(module.path);
  } catch {
    fail("Theme resolution changed during import");
  }
  if (
    canonicalBase !== base.canonical ||
    canonicalModule !== module.path ||
    !sameIdentity(
      base.identity,
      identity(canonicalBase, "Theme base directory", "isDirectory"),
    ) ||
    !sameIdentity(
      module.identity,
      identity(canonicalModule, "Theme module", "isFile"),
    )
  ) {
    fail("Theme resolution changed during import");
  }
}

export async function loadTheme(specifier, baseDirectory) {
  const selected = boundedString(
    specifier,
    MAX_THEME_SPECIFIER_BYTES,
    "Theme specifier",
  );
  if (URL_SCHEME.test(selected) || selected.startsWith("//")) {
    fail("Remote and URL theme specifiers are not supported");
  }

  const base = canonicalDirectory(baseDirectory);
  const module = resolveThemeModule(selected, base);
  let namespace;
  try {
    namespace = await import(pathToFileURL(module.path).href);
  } catch {
    fail("Theme module could not be imported");
  }
  revalidate(base, module);
  const theme = namespace.default ?? namespace.theme402v;
  if (theme === undefined) {
    fail("Theme module must export default or theme402v");
  }
  return theme;
}

export { OFFICIAL_THEME };
