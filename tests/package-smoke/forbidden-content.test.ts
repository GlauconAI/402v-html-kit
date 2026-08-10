import { readdir, readFile } from "node:fs/promises";
import { extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../", import.meta.url));
const packageRoot = join(workspaceRoot, "packages");
const publicFileExtensions = new Set([".cjs", ".json", ".mjs", ".mts"]);
const forbiddenPatterns = [
  /Supabase/iu,
  /Vercel/iu,
  /NEXT_PUBLIC_/u,
  /\/Users\/glaucon(?:\/|\b)/u,
  /\/(?:Users|home)\/[A-Za-z0-9._-]+\//u,
  /[A-Za-z]:\\Users\\[A-Za-z0-9._-]+\\/u,
  /file:\/\/\/(?:Users|home|private|tmp|var)\//u,
  /\/(?:private\/)?tmp\/[A-Za-z0-9._-]+/u,
  /\/var\/folders\/[A-Za-z0-9._/-]+/u,
  /-----BEGIN (?:EC |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /AKIA[0-9A-Z]{16}/u,
  /gh[opusr]_[A-Za-z0-9]{20,}/u,
  /xox[a-z]-[A-Za-z0-9-]{10,}/iu,
  /(?:api[_-]?key|password|secret)\s*[:=]\s*["'][^"'\n$]{8,}["']/iu,
] as const;
const reviewedThemeBrandAnchor =
  '<a class="artifact-brand" href="https://402v.com">402v</a>';
const reviewedThemeBrandFiles = new Set([
  "packages/theme-402v/src/interactive-shell.mjs",
  "packages/theme-402v/src/note-shell.mjs",
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
    const matches: string[] = [];
    const reviewedBrandFiles = new Set<string>();
    for (const path of await publicProductionFiles()) {
      const packagePath = relative(workspaceRoot, path).split(sep).join("/");
      let source = await readFile(path, "utf8");
      if (reviewedThemeBrandFiles.has(packagePath)) {
        expect(source.split(reviewedThemeBrandAnchor)).toHaveLength(2);
        reviewedBrandFiles.add(packagePath);
        source = source.replace(reviewedThemeBrandAnchor, "");
      }
      if (/402v\.com/iu.test(source)) {
        matches.push(`${packagePath}: 402v\\.com`);
      }
      for (const pattern of forbiddenPatterns) {
        if (pattern.test(source)) {
          matches.push(`${packagePath}: ${pattern.source}`);
        }
      }
    }
    expect(reviewedBrandFiles).toEqual(reviewedThemeBrandFiles);
    expect(matches).toEqual([]);
  });
});
