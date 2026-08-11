import {
  linkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import type { PathLike } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactBuildError } from "@402v/html-kit-core";
import { atomicContainedWrite } from "../src/starter-write.mjs";

const roots: string[] = [];

function temporaryRoot() {
  const root = mkdtempSync(join(tmpdir(), "402v-starter-write-"));
  roots.push(root);
  return root;
}

describe("atomic starter installation", () => {
  afterEach(async () => {
    const { rm } = await import("node:fs/promises");
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
  });

  it("preserves a destination that appears immediately before no-clobber install", () => {
    const root = temporaryRoot();
    const destination = join(root, "renderer.mjs");
    const attacker = "attacker-owned\n";

    let caught: unknown;
    try {
      atomicContainedWrite(root, "renderer.mjs", "generated\n", false, {
        link(temporary: PathLike, target: PathLike) {
          expect(String(target)).toBe(destination);
          writeFileSync(destination, attacker, { flag: "wx" });
          linkSync(temporary, target);
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ArtifactBuildError);
    expect((caught as ArtifactBuildError).code).toBe("OUTPUT_EXISTS");
    expect(readFileSync(destination, "utf8")).toBe(attacker);
    expect(readdirSync(root)).toEqual(["renderer.mjs"]);
  });
});
