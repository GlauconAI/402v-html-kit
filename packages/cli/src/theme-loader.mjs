import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
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
import { parse } from "acorn";

const OFFICIAL_THEME = "@402v/theme-402v";
const MAX_THEME_SPECIFIER_BYTES = 256;
const MAX_BASE_DIRECTORY_BYTES = 4_096;
const MAX_LOCAL_THEME_BYTES = 1024 * 1024;
const MAX_LOCAL_GRAPH_BYTES = 4 * 1024 * 1024;
const MAX_LOCAL_GRAPH_FILES = 64;
const MAX_LOCAL_GRAPH_DEPTH = 32;
const MAX_LOCAL_AST_NODES = 100_000;
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
    const requested = resolve(base.canonical, specifier);
    let canonical;
    try {
      canonical = realpathSync(requested);
    } catch {
      fail("Local theme module could not be resolved");
    }
    if (canonical !== requested || !contained(base.canonical, canonical)) {
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

function pinnedLocalFile(path, base, budget) {
  let canonical;
  let pathStats;
  try {
    canonical = realpathSync(path);
    pathStats = lstatSync(path, { bigint: true });
  } catch {
    fail("Local theme dependency could not be resolved safely");
  }
  if (
    canonical !== path ||
    !contained(base.canonical, canonical) ||
    pathStats.isSymbolicLink() ||
    !pathStats.isFile()
  ) {
    fail("Local theme dependencies must be canonical contained files");
  }

  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (
      !before.isFile() ||
      before.dev !== pathStats.dev ||
      before.ino !== pathStats.ino ||
      before.size > BigInt(MAX_LOCAL_THEME_BYTES)
    ) {
      fail("Local theme dependency changed before it could be read safely");
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
      fail("Local theme dependency changed while it was being read");
    }
    budget.bytes += bytes.byteLength;
    if (budget.bytes > MAX_LOCAL_GRAPH_BYTES) {
      fail("Local theme dependency graph exceeds its aggregate byte limit");
    }
    let source;
    try {
      source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("Local theme dependencies must contain strict UTF-8");
    }
    return Object.freeze({
      path,
      label: relative(base.canonical, path),
      source,
      identity: Object.freeze({
        dev: before.dev,
        ino: before.ino,
        size: before.size,
        mtimeNs: before.mtimeNs,
        ctimeNs: before.ctimeNs,
      }),
    });
  } catch (error) {
    if (error instanceof ArtifactBuildError) throw error;
    fail("Local theme dependency could not be read safely");
  } finally {
    if (descriptor !== undefined) {
      try {
        closeSync(descriptor);
      } catch {}
    }
  }
}

function importReferences(source) {
  let program;
  try {
    program = parse(source, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
  } catch {
    fail("Local theme dependency must be valid ESM");
  }

  const references = [];
  const pending = [{ deferred: false, node: program, parent: undefined }];
  let nodes = 0;
  while (pending.length > 0) {
    const { deferred, node, parent } = pending.pop();
    if (node === null || typeof node !== "object") continue;
    nodes += 1;
    if (nodes > MAX_LOCAL_AST_NODES) {
      fail("Local theme dependency syntax exceeds its node limit");
    }
    let sourceNode;
    if (
      node.type === "ImportDeclaration" ||
      node.type === "ExportNamedDeclaration" ||
      node.type === "ExportAllDeclaration"
    ) {
      sourceNode = node.source;
    } else if (node.type === "ImportExpression") {
      sourceNode = node.source;
      if (
        sourceNode?.type !== "Literal" ||
        typeof sourceNode.value !== "string"
      ) {
        fail("Local theme dynamic imports must use string literals");
      }
      if (
        isAbsolute(sourceNode.value) ||
        !localSpecifier(sourceNode.value)
      ) {
        fail("Local theme dynamic imports must use relative paths");
      }
      if (
        deferred ||
        parent?.type !== "AwaitExpression" ||
        parent.argument !== node
      ) {
        fail(
          "Local theme dynamic imports must be directly awaited at top level",
        );
      }
    }
    if (sourceNode !== null && sourceNode !== undefined) {
      if (
        sourceNode.type !== "Literal" ||
        typeof sourceNode.value !== "string"
      ) {
        fail("Local theme imports must use string literals");
      }
      references.push({
        end: sourceNode.end,
        specifier: sourceNode.value,
        start: sourceNode.start,
      });
    }
    const childDeferred =
      deferred ||
      node.type === "FunctionDeclaration" ||
      node.type === "FunctionExpression" ||
      node.type === "ArrowFunctionExpression" ||
      node.type === "ClassDeclaration" ||
      node.type === "ClassExpression";
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const child of value) {
          pending.push({ deferred: childDeferred, node: child, parent: node });
        }
      } else if (value !== null && typeof value === "object") {
        pending.push({ deferred: childDeferred, node: value, parent: node });
      }
    }
  }
  return references;
}

function localDependencyPath(specifier, parentPath, base) {
  if (
    typeof specifier !== "string" ||
    specifier.length === 0 ||
    specifier.includes("\0") ||
    Buffer.byteLength(specifier, "utf8") > MAX_THEME_SPECIFIER_BYTES
  ) {
    fail("Local theme import specifiers must be bounded strings");
  }
  if (specifier.startsWith("//")) {
    fail("Local theme dependencies cannot use URL imports");
  }
  if (URL_SCHEME.test(specifier)) {
    if (specifier.startsWith("node:")) return undefined;
    fail("Local theme dependencies cannot use URL imports");
  }
  if (isAbsolute(specifier)) {
    fail("Local theme dependencies must use relative paths");
  }
  if (!localSpecifier(specifier)) return undefined;
  let url;
  let requested;
  try {
    url = new URL(specifier, pathToFileURL(parentPath));
    if (url.protocol !== "file:" || url.search !== "" || url.hash !== "") {
      fail("Local theme dependencies must use plain relative paths");
    }
    requested = fileURLToPath(url);
  } catch (error) {
    if (error instanceof ArtifactBuildError) throw error;
    fail("Local theme dependency path is invalid");
  }
  if (!contained(base.canonical, requested)) {
    fail("Local theme dependency escaped the selected directory");
  }
  return requested;
}

function rewriteSource(source, rewrites, originalPath, outputBudget, limits) {
  const suffix = `\n//# sourceURL=${pathToFileURL(originalPath).href}\n`;
  let projectedBytes = Buffer.byteLength(source) + Buffer.byteLength(suffix);
  const prepared = [];
  let cursor = 0;
  for (const rewrite of [...rewrites].sort((left, right) => left.start - right.start)) {
    if (
      !Number.isSafeInteger(rewrite.start) ||
      !Number.isSafeInteger(rewrite.end) ||
      rewrite.start < cursor ||
      rewrite.end < rewrite.start ||
      rewrite.end > source.length
    ) {
      fail("Local theme import rewrite ranges are invalid");
    }
    const replacement = JSON.stringify(rewrite.value);
    projectedBytes +=
      Buffer.byteLength(replacement) -
      Buffer.byteLength(source.slice(rewrite.start, rewrite.end));
    if (
      projectedBytes > limits.fileBytes ||
      outputBudget.bytes + projectedBytes > limits.graphBytes
    ) {
      fail("Local theme rewritten snapshot exceeds its byte limit");
    }
    prepared.push({ ...rewrite, replacement });
    cursor = rewrite.end;
  }
  if (
    projectedBytes > limits.fileBytes ||
    outputBudget.bytes + projectedBytes > limits.graphBytes
  ) {
    fail("Local theme rewritten snapshot exceeds its byte limit");
  }
  outputBudget.bytes += projectedBytes;

  const chunks = [];
  cursor = 0;
  for (const rewrite of prepared) {
    chunks.push(source.slice(cursor, rewrite.start), rewrite.replacement);
    cursor = rewrite.end;
  }
  chunks.push(source.slice(cursor), suffix);
  return chunks.join("");
}

function buildLocalGraph(entryPath, base, limits) {
  const budget = { bytes: 0 };
  const outputBudget = { bytes: 0 };
  const records = new Map();
  const snapshotNames = new Set();

  function uniqueSnapshotName() {
    for (;;) {
      const name = `.402v-theme-snapshot-${randomBytes(24).toString("hex")}.mjs`;
      if (!snapshotNames.has(name)) {
        snapshotNames.add(name);
        return name;
      }
    }
  }

  function visit(path, depth) {
    if (records.has(path)) return records.get(path);
    if (depth > MAX_LOCAL_GRAPH_DEPTH) {
      fail("Local theme dependency graph exceeds its depth limit");
    }
    if (records.size >= MAX_LOCAL_GRAPH_FILES) {
      fail("Local theme dependency graph exceeds its file count limit");
    }
    const pinned = pinnedLocalFile(path, base, budget);
    const record = Object.freeze({
      ...pinned,
      snapshotName: uniqueSnapshotName(),
    });
    records.set(path, record);
    const rewrites = [];
    for (const reference of importReferences(record.source)) {
      const dependency = localDependencyPath(
        reference.specifier,
        record.path,
        base,
      );
      if (dependency !== undefined) {
        const dependencyRecord = visit(dependency, depth + 1);
        rewrites.push({
          end: reference.end,
          start: reference.start,
          value: `./${dependencyRecord.snapshotName}`,
        });
        continue;
      }
      if (reference.specifier.startsWith("#")) {
        fail("Local theme package-import aliases are not supported");
      }
      if (!reference.specifier.startsWith("node:")) {
        let resolvedSpecifier;
        try {
          resolvedSpecifier = import.meta.resolve(
            reference.specifier,
            pathToFileURL(record.path).href,
          );
        } catch {
          fail("Local theme package import could not be resolved");
        }
        rewrites.push({
          end: reference.end,
          start: reference.start,
          value: resolvedSpecifier,
        });
      }
    }
    records.set(
      path,
      Object.freeze({
        ...record,
        source: rewriteSource(
          record.source,
          rewrites,
          record.path,
          outputBudget,
          limits,
        ),
      }),
    );
    return records.get(path);
  }

  visit(entryPath, 0);
  return Object.freeze({
    entryName: records.get(entryPath).snapshotName,
    records: Object.freeze([...records.values()]),
  });
}

function revalidateLocalGraph(base, graph) {
  let canonicalBase;
  let baseStats;
  try {
    canonicalBase = realpathSync(base.requested);
    baseStats = statSync(canonicalBase, { bigint: true });
  } catch {
    fail("Local theme base changed during graph snapshot");
  }
  if (
    canonicalBase !== base.canonical ||
    baseStats.dev !== base.identity.dev ||
    baseStats.ino !== base.identity.ino
  ) {
    fail("Local theme base changed during graph snapshot");
  }
  for (const record of graph.records) {
    let canonical;
    let stats;
    let linkStats;
    try {
      canonical = realpathSync(record.path);
      stats = statSync(canonical, { bigint: true });
      linkStats = lstatSync(record.path, { bigint: true });
    } catch {
      fail("Local theme dependency changed during graph snapshot");
    }
    if (
      canonical !== record.path ||
      linkStats.isSymbolicLink() ||
      stats.dev !== record.identity.dev ||
      stats.ino !== record.identity.ino ||
      stats.size !== record.identity.size ||
      stats.mtimeNs !== record.identity.mtimeNs ||
      stats.ctimeNs !== record.identity.ctimeNs
    ) {
      fail("Local theme dependency changed during graph snapshot");
    }
  }
}

function matchingSnapshotFile(base, file) {
  if (
    dirname(file.path) !== base.canonical ||
    !file.path.startsWith(join(base.canonical, ".402v-theme-snapshot-"))
  ) {
    return false;
  }
  try {
    const stats = lstatSync(file.path, { bigint: true });
    return (
      !stats.isSymbolicLink() &&
      stats.isFile() &&
      stats.dev === file.identity.dev &&
      stats.ino === file.identity.ino
    );
  } catch {
    return false;
  }
}

function removeSnapshotFiles(base, files) {
  for (const file of files) {
    if (!matchingSnapshotFile(base, file)) continue;
    try {
      unlinkSync(file.path);
    } catch {}
  }
}

function revalidateSnapshotFiles(base, files) {
  if (!files.every((file) => matchingSnapshotFile(base, file))) {
    fail("Local theme snapshot files changed before import");
  }
}

function stageLocalGraph(base, graph) {
  const files = [];
  try {
    for (const record of graph.records) {
      const destination = join(base.canonical, record.snapshotName);
      if (dirname(destination) !== base.canonical) {
        fail("Local theme snapshot path escaped its tree");
      }
      let descriptor;
      try {
        descriptor = openSync(
          destination,
          constants.O_CREAT |
            constants.O_EXCL |
            constants.O_WRONLY |
            (constants.O_NOFOLLOW ?? 0),
          0o400,
        );
        const opened = fstatSync(descriptor, { bigint: true });
        if (!opened.isFile()) {
          fail("Local theme snapshot file could not be installed safely");
        }
        files.push(
          Object.freeze({
            identity: Object.freeze({ dev: opened.dev, ino: opened.ino }),
            path: destination,
          }),
        );
        writeFileSync(descriptor, record.source, "utf8");
        const stats = fstatSync(descriptor, { bigint: true });
        if (
          !stats.isFile() ||
          stats.dev !== opened.dev ||
          stats.ino !== opened.ino ||
          stats.size !== BigInt(Buffer.byteLength(record.source))
        ) {
          fail("Local theme snapshot file could not be installed safely");
        }
      } finally {
        if (descriptor !== undefined) {
          try {
            closeSync(descriptor);
          } catch {}
        }
      }
    }
    return Object.freeze({
      entryPath: join(base.canonical, graph.entryName),
      files: Object.freeze(files),
    });
  } catch (error) {
    removeSnapshotFiles(base, files);
    if (error instanceof ArtifactBuildError) throw error;
    fail("Local theme snapshot files could not be installed safely");
  }
}

function snapshotLimits(options) {
  const requested = options?.maxSnapshotBytes;
  if (
    requested !== undefined &&
    (!Number.isSafeInteger(requested) || requested <= 0)
  ) {
    fail("Local theme snapshot byte limit must be a positive safe integer");
  }
  const injected = requested ?? MAX_LOCAL_GRAPH_BYTES;
  return Object.freeze({
    fileBytes: Math.min(MAX_LOCAL_THEME_BYTES, injected),
    graphBytes: Math.min(MAX_LOCAL_GRAPH_BYTES, injected),
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

export async function loadTheme(specifier, baseDirectory, options) {
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
  const graph = module.local
    ? buildLocalGraph(module.path, base, snapshotLimits(options))
    : undefined;
  const snapshot = graph === undefined ? undefined : stageLocalGraph(base, graph);
  let namespace;
  try {
    if (graph === undefined) revalidate(base, module);
    else {
      revalidateLocalGraph(base, graph);
      revalidateSnapshotFiles(base, snapshot.files);
    }
    namespace = await import(
      snapshot === undefined
        ? pathToFileURL(module.path).href
        : pathToFileURL(snapshot.entryPath).href
    );
  } catch {
    fail("Theme module could not be imported");
  } finally {
    if (snapshot !== undefined) removeSnapshotFiles(base, snapshot.files);
  }
  if (!module.local) revalidate(base, module);
  const theme = namespace.default ?? namespace.theme402v;
  if (theme === undefined) {
    fail("Theme module must export default or theme402v");
  }
  return theme;
}

export { OFFICIAL_THEME };
