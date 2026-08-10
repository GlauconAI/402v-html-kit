import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ArtifactBuildError } from "@402v/html-kit-core";
import { readJsonValue } from "../src/json-input.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

describe("bounded CLI JSON input", () => {
  it("bounds reads when the same opened file grows after its initial fstat", () => {
    const root = mkdtempSync(join(tmpdir(), "html-kit-json-growth-"));
    roots.push(root);
    const inputPath = join(root, "input.json");
    writeFileSync(inputPath, '{"small":true}');
    const maximumBytes = 32;
    let grew = false;
    let requestedBytes = 0;

    let caught: unknown;
    try {
      readJsonValue(inputPath, {
        maximumBytes,
        operations: {
          close: closeSync,
          fstat: fstatSync,
          lstat: lstatSync,
          open: openSync,
          read(
            descriptor: number,
            buffer: Buffer,
            offset: number,
            length: number,
            position: null,
          ) {
            requestedBytes += length;
            expect(length).toBeLessThanOrEqual(maximumBytes + 1);
            if (!grew) {
              grew = true;
              writeFileSync(inputPath, `{"grown":"${"x".repeat(128)}"}`);
            }
            return readSync(descriptor, buffer, offset, length, position);
          },
          realpath: realpathSync,
          constants,
        },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ArtifactBuildError);
    expect(caught).toMatchObject({ code: "INVALID_DATA_BLOCK" });
    expect(grew).toBe(true);
    expect(requestedBytes).toBeLessThanOrEqual(maximumBytes + 1);
  });

  it("rejects an oversized same-path replacement while reading the pinned file", () => {
    const root = mkdtempSync(join(tmpdir(), "html-kit-json-replacement-"));
    roots.push(root);
    const inputPath = join(root, "input.json");
    const replacementPath = join(root, "replacement.json");
    writeFileSync(inputPath, '{"small":true}');
    writeFileSync(replacementPath, `{"grown":"${"x".repeat(128)}"}`);
    let replaced = false;

    expect(() => readJsonValue(inputPath, {
      maximumBytes: 32,
      operations: {
        close: closeSync,
        fstat: fstatSync,
        lstat: lstatSync,
        open: openSync,
        read(
          descriptor: number,
          buffer: Buffer,
          offset: number,
          length: number,
          position: null,
        ) {
          if (!replaced) {
            replaced = true;
            renameSync(replacementPath, inputPath);
          }
          return readSync(descriptor, buffer, offset, length, position);
        },
        realpath: realpathSync,
        constants,
      },
    })).toThrowError(expect.objectContaining({ code: "INVALID_DATA_BLOCK" }));
    expect(replaced).toBe(true);
  });
});
