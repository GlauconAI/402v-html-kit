import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { inspectPublishedText } from "./pack-smoke.mjs";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageRoot = join(workspaceRoot, "packages");
const publicFileExtensions = new Set([".cjs", ".json", ".mjs", ".mts"]);
const reviewedThemeBrandFiles = new Set([
  "packages/theme-402v/src/interactive-shell.mjs",
  "packages/theme-402v/src/note-shell.mjs",
]);
const publishedPackageNames = new Map([
  ["cli", "@402v/html-kit-cli"],
  ["core", "@402v/html-kit-core"],
  ["theme-402v", "@402v/theme-402v"],
]);

async function publicProductionFiles() {
  const packageDirectories = await readdir(packageRoot, { withFileTypes: true });
  const files: string[] = [];
  for (const packageDirectory of packageDirectories) {
    if (!packageDirectory.isDirectory()) continue;
    files.push(join(packageRoot, packageDirectory.name, "package.json"));
    const sourceRoot = join(packageRoot, packageDirectory.name, "src");
    const pending = [sourceRoot];
    while (pending.length > 0) {
      const directory = pending.pop()!;
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) pending.push(path);
        else if (entry.isFile() && publicFileExtensions.has(extname(entry.name))) {
          files.push(path);
        }
      }
    }
  }
  return files.sort();
}

describe("published package boundary", () => {
  it("contains no site, private-infrastructure, credential, or host-path leaks", async () => {
    const reviewedBrandFiles = new Set<string>();
    for (const path of await publicProductionFiles()) {
      const packagePath = relative(workspaceRoot, path).split(sep).join("/");
      const [, packageDirectory] = packagePath.split("/");
      const packageName = publishedPackageNames.get(packageDirectory);
      expect(packageName, `Unknown published package directory: ${packageDirectory}`).toBeDefined();
      inspectPublishedText({
        packageName: packageName!,
        path: packagePath.replace(/^packages\/[^/]+\//u, ""),
        content: await readFile(path),
        reviewedBrandFiles,
      });
    }
    expect(new Set(
      [...reviewedBrandFiles].map((path) => `packages/theme-402v/${path}`),
    )).toEqual(reviewedThemeBrandFiles);
  });
});
