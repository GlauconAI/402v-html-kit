import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ArtifactBuildError } from "@402v/html-kit-core";

const OFFICIAL_THEME = "@402v/theme-402v";
const MAX_THEME_SPECIFIER_BYTES = 256;
const MAX_BASE_DIRECTORY_BYTES = 4_096;
const MAX_LOCAL_THEME_BYTES = 1024 * 1024;
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
  let local = false;
  if (localSpecifier(specifier)) {
    local = true;
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
    const require = createRequire(join(base.canonical, "package.json"));
    try {
      path = realpathSync(require.resolve(specifier));
    } catch (cause) {
      if (
        cause?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED" &&
        specifier !== OFFICIAL_THEME
      ) {
        fail("Installed theme package could not be resolved");
      }
      // Import-only packages intentionally cannot be resolved under the
      // CommonJS condition. Preserve their package exports by retrying under
      // the ESM import condition from the same caller-selected anchor.
      try {
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
          const cliRequire = createRequire(import.meta.url);
          try {
            path = realpathSync(cliRequire.resolve(specifier));
          } catch (cliCause) {
            if (cliCause?.code !== "ERR_PACKAGE_PATH_NOT_EXPORTED") throw cliCause;
            path = realpathSync(
              fileURLToPath(import.meta.resolve(specifier, import.meta.url)),
            );
          }
        } catch {
          fail("Installed theme package could not be resolved");
        }
      }
    }
  }
  return Object.freeze({
    path,
    identity: identity(path, "Theme module", "isFile"),
    local,
  });
}

function snapshotLocalModule(module) {
  let descriptor;
  try {
    descriptor = openSync(
      module.path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== module.identity.dev ||
      before.ino !== module.identity.ino ||
      before.size > BigInt(MAX_LOCAL_THEME_BYTES)
    ) {
      fail("Local theme module changed before it could be read safely");
    }
    const bytes = readFileSync(descriptor);
    const after = fstatSync(descriptor, { bigint: true });
    if (
      after.dev !== before.dev ||
      after.ino !== before.ino ||
      after.size !== before.size ||
      after.mtimeNs !== before.mtimeNs ||
      after.ctimeNs !== before.ctimeNs
    ) {
      fail("Local theme module changed while it was being read");
    }
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("Local theme module must contain strict UTF-8");
    }
    return `${source}\n//# sourceURL=${pathToFileURL(module.path).href}\n`;
  } catch (error) {
    if (error instanceof ArtifactBuildError) throw error;
    fail("Local theme module could not be read safely");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function stageLocalSnapshot(module, source) {
  const directory = dirname(module.path);
  const path = join(
    directory,
    `.402v-theme-${randomBytes(24).toString("hex")}.mjs`,
  );
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_WRONLY |
        (constants.O_NOFOLLOW ?? 0),
      0o400,
    );
    writeFileSync(descriptor, source, "utf8");
    const stats = fstatSync(descriptor, { bigint: true });
    if (!stats.isFile() || stats.size !== BigInt(Buffer.byteLength(source))) {
      fail("Local theme snapshot could not be installed safely");
    }
    closeSync(descriptor);
    descriptor = undefined;
    return path;
  } catch (error) {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
    try {
      unlinkSync(path);
    } catch {}
    if (error instanceof ArtifactBuildError) throw error;
    fail("Local theme snapshot could not be installed safely");
  }
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
  const localSource = module.local ? snapshotLocalModule(module) : undefined;
  revalidate(base, module);
  const stagedPath =
    localSource === undefined
      ? undefined
      : stageLocalSnapshot(module, localSource);
  let namespace;
  try {
    if (stagedPath !== undefined) revalidate(base, module);
    namespace = await import(
      stagedPath === undefined
        ? pathToFileURL(module.path).href
        : pathToFileURL(stagedPath).href
    );
  } catch {
    fail("Theme module could not be imported");
  } finally {
    if (stagedPath !== undefined) {
      try {
        unlinkSync(stagedPath);
      } catch {}
    }
  }
  if (!module.local) revalidate(base, module);
  const theme = namespace.default ?? namespace.theme402v;
  if (theme === undefined) {
    fail("Theme module must export default or theme402v");
  }
  return theme;
}

export { OFFICIAL_THEME };
