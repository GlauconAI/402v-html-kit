import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

function workflow(name: "ci" | "release"): Record<string, any> {
  return parse(
    readFileSync(new URL(`../../.github/workflows/${name}.yml`, import.meta.url), "utf8"),
  ) as Record<string, any>;
}

function allRunCommands(value: Record<string, any>): string {
  return Object.values(value.jobs as Record<string, any>)
    .flatMap((job) => job.steps ?? [])
    .map((step: Record<string, unknown>) => step.run)
    .filter((command): command is string => typeof command === "string")
    .join("\n");
}

describe("GitHub workflow contracts", () => {
  it("runs every CI gate on Node 22 and 24 with current action pins", () => {
    const ci = workflow("ci");
    expect(ci).toHaveProperty("on");
    expect(ci).toHaveProperty("jobs");
    const source = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(source).toContain("actions/checkout@v6");
    expect(source).toContain("actions/setup-node@v6");
    expect(source).not.toMatch(/uses:\s+[^\s]+@(?!v6\b)/u);

    const jobs = ci.jobs as Record<string, any>;
    const matrixJob = Object.values(jobs).find(
      (job) => job.strategy?.matrix?.node !== undefined,
    );
    expect(matrixJob?.strategy.matrix.node.map(String).sort()).toEqual(["22", "24"]);
    expect(matrixJob?.["runs-on"]).toBe("ubuntu-latest");
    const commands = allRunCommands(ci);
    for (const command of [
      "npm ci",
      "npm run typecheck",
      "npm test",
      "npm run pack:check",
      "npm audit --omit=dev",
    ]) {
      expect(commands).toContain(command);
    }
    for (const label of [
      "deterministic examples",
      "real Chrome",
      "license",
      "forbidden",
    ]) {
      expect(source.toLowerCase()).toContain(label.toLowerCase());
    }
  });

  it("publishes only signed exact SemVer tags through npm trusted publishing", () => {
    const release = workflow("release");
    expect(release).toHaveProperty("on");
    expect(release).toHaveProperty("jobs");
    expect(release.permissions).toEqual({ contents: "read", "id-token": "write" });
    const source = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(source).toContain("actions/checkout@v6");
    expect(source).toContain("actions/setup-node@v6");
    expect(source).toContain("node-version: 24");
    expect(source).toContain("npm@11.12.1");
    expect(source).toContain("environment: npm");
    expect(source).toMatch(/verification[\s\S]*verified/u);
    expect(source).toContain("^v[0-9]+\\.[0-9]+\\.[0-9]+$");
    expect(source).toMatch(/packages\/core\/package\.json[\s\S]*packages\/theme-402v\/package\.json[\s\S]*packages\/cli\/package\.json/u);
    expect(source).toMatch(/npm publish --workspace @402v\/html-kit-core --access public --provenance[\s\S]*npm publish --workspace @402v\/theme-402v --access public --provenance[\s\S]*npm publish --workspace @402v\/html-kit-cli --access public --provenance/u);
    expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u);
    expect(source).toMatch(/trusted publish|trusted publisher/iu);
  });
});
