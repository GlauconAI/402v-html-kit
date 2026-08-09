import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { extractDataBlocks } from "@402v/html-kit-core";

describe("frozen contract-v1 primitives", () => {
  it("extracts canonical blocks without changing fixture bytes", () => {
    const path = new URL("./fixtures/v1/interactive.html", import.meta.url);
    const html = readFileSync(path, "utf8");
    expect([...extractDataBlocks(html).keys()]).toEqual(["project-registry"]);
    expect(readFileSync(path)).toEqual(Buffer.from(html, "utf8"));
  });
});
