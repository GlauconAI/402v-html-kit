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

const actionPins = {
  "actions/checkout": "d23441a48e516b6c34aea4fa41551a30e30af803",
  "actions/setup-node": "249970729cb0ef3589644e2896645e5dc5ba9c38",
} as const;

function allUses(value: Record<string, any>): string[] {
  return Object.values(value.jobs as Record<string, any>)
    .flatMap((job) => job.steps ?? [])
    .map((step: Record<string, unknown>) => step.uses)
    .filter((uses): uses is string => typeof uses === "string");
}

describe("GitHub workflow contracts", () => {
  it("serializes test files for reliable plain npm test runs", async () => {
    const configUrl = new URL("../../vitest.config.ts", import.meta.url).href;
    const config = (await import(configUrl)).default as {
      test?: { fileParallelism?: boolean };
    };
    expect(config.test?.fileParallelism).toBe(false);
  });

  it("gives the no-host-fallback probe a bounded timeout", () => {
    const source = readFileSync(new URL("../browser/examples.test.ts", import.meta.url), "utf8");
    const start = source.indexOf('it("cannot resolve the official theme from the host workspace"');
    const end = source.indexOf('it("disables npm update notices', start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toMatch(/20_000\s*\);\s*$/u);
  });

  it("runs every CI gate on Node 22 and 24 with reviewed immutable action pins", () => {
    const ci = workflow("ci");
    expect(ci).toHaveProperty("on");
    expect(ci).toHaveProperty("jobs");
    const source = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    expect(allUses(ci)).toEqual([
      `actions/checkout@${actionPins["actions/checkout"]}`,
      `actions/setup-node@${actionPins["actions/setup-node"]}`,
      `actions/checkout@${actionPins["actions/checkout"]}`,
      `actions/setup-node@${actionPins["actions/setup-node"]}`,
    ]);
    expect(source.match(/# v6/g)?.length).toBe(4);
    expect(source).not.toMatch(/uses:\s+[^\s]+@v\d+/u);

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

  it("isolates tag verification before trusted publishing and binds release to the verified commit", () => {
    const release = workflow("release");
    expect(release).toHaveProperty("on");
    expect(release).toHaveProperty("jobs");
    expect(release.permissions).toEqual({});
    const source = readFileSync(new URL("../../.github/workflows/release.yml", import.meta.url), "utf8");
    expect(allUses(release)).toEqual([
      `actions/checkout@${actionPins["actions/checkout"]}`,
      `actions/checkout@${actionPins["actions/checkout"]}`,
      `actions/setup-node@${actionPins["actions/setup-node"]}`,
    ]);
    expect(source.match(/# v6/g)?.length).toBe(3);
    expect(source).not.toMatch(/uses:\s+[^\s]+@v\d+/u);
    expect(release.concurrency).toEqual({
      group: "release-${{ github.ref }}",
      "cancel-in-progress": false,
    });

    const jobs = release.jobs as Record<string, any>;
    const verifyTag = jobs["verify-tag"];
    expect(verifyTag.permissions).toEqual({ contents: "read" });
    expect(verifyTag.outputs).toEqual({
      commit: "${{ steps.verify.outputs.commit }}",
      version: "${{ steps.verify.outputs.version }}",
      repository: "${{ steps.verify.outputs.repository }}",
      workflow: "${{ steps.verify.outputs.workflow }}",
      ref: "${{ steps.verify.outputs.ref }}",
      tag: "${{ steps.verify.outputs.tag }}",
    });
    expect(verifyTag.steps.map((step: Record<string, unknown>) => step.uses).filter(Boolean)).toEqual([
      `actions/checkout@${actionPins["actions/checkout"]}`,
    ]);
    const verifyCommands = (verifyTag.steps as Record<string, string>[])
      .map((step) => step.run ?? "")
      .join("\n");
    expect(verifyCommands).toContain("node .github/scripts/release.mjs verify-tag");
    expect(verifyCommands).not.toMatch(/\bnpm(?:\s|$)/u);

    const publish = jobs.release;
    expect(publish.needs).toBe("verify-tag");
    expect(publish.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(publish.environment).toBe("npm");
    expect(publish.steps[0].with.ref).toBe("${{ needs.verify-tag.outputs.commit }}");
    expect(publish.steps[0].with["persist-credentials"]).toBe(false);
    expect(source).toContain("node-version: 24");
    expect(source).toContain("npm@11.12.1");
    expect(source).toContain("node .github/scripts/release.mjs prepare");
    expect(source).toContain("node .github/scripts/release.mjs publish");
    for (const identity of [
      "RELEASE_SOURCE_REPOSITORY: ${{ needs.verify-tag.outputs.repository }}",
      "RELEASE_SOURCE_WORKFLOW: ${{ needs.verify-tag.outputs.workflow }}",
      "RELEASE_SOURCE_REF: ${{ needs.verify-tag.outputs.ref }}",
      "RELEASE_SOURCE_TAG: ${{ needs.verify-tag.outputs.tag }}",
      "RELEASE_SOURCE_COMMIT: ${{ needs.verify-tag.outputs.commit }}",
    ]) {
      expect(source.match(new RegExp(identity.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "gu"))?.length).toBe(2);
    }
    const helperSource = readFileSync(new URL("../../.github/scripts/release.mjs", import.meta.url), "utf8");
    expect(helperSource).toMatch(/npm[\s\S]*audit[\s\S]*signatures[\s\S]*--json[\s\S]*--include-attestations/u);
    expect(helperSource).toMatch(/spawnSync\("npm",\s*\["view"[\s\S]*timeout:\s*30_000[\s\S]*maxBuffer/u);
    expect(helperSource).toMatch(/\["pack"[\s\S]*timeout:\s*120_000[\s\S]*maxBuffer/u);
    expect(helperSource).toMatch(/\["publish"[\s\S]*stdio:\s*"inherit"[\s\S]*timeout:\s*120_000/u);

    const commands = (publish.steps as Record<string, string>[])
      .map((step) => step.run ?? "")
      .join("\n");
    const ordered = [
      "git rev-parse HEAD",
      "npm install --global npm@11.12.1",
      "npm ci",
      "npm run typecheck",
      "npm test",
      "npm run --silent pack:check",
      "npm audit --omit=dev",
      "node .github/scripts/release.mjs prepare",
      "node .github/scripts/release.mjs publish",
    ];
    let previous = -1;
    for (const command of ordered) {
      const index = commands.indexOf(command);
      expect(index, `${command} is missing or out of order`).toBeGreaterThan(previous);
      previous = index;
    }
    expect(commands).toMatch(/npm run --silent pack:check\s*>\s*"?\$RUNNER_TEMP\/pack-gate\.json"?/u);
    expect(source).not.toMatch(/NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./u);
  });
});
