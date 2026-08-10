import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliPackage = fileURLToPath(new URL("../package.json", import.meta.url));
const workspaceRoot = resolve(dirname(cliPackage), "../..");
const workspaceCli = join(dirname(cliPackage), "src", "cli.mjs");
const roots: string[] = [];

type CliResult = {
  error?: Error;
  status: number | null;
  stderr: string;
  stdout: string;
  json?: Record<string, any>;
};

function temporaryRoot(label = "402v-cli-test-") {
  const root = mkdtempSync(join(tmpdir(), label));
  roots.push(root);
  return root;
}

function runExecutable(
  executable: string,
  args: string[],
  cwd: string,
): CliResult {
  const result = spawnSync(executable, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
    timeout: 30_000,
  }) as unknown as CliResult;
  const lines = result.stdout.trimEnd().split("\n");
  if (result.stdout.endsWith("\n") && lines.length === 1) {
    try {
      result.json = JSON.parse(lines[0]);
    } catch {
      // Explicit help is the only accepted non-JSON output.
    }
  }
  return result;
}

function expectJsonProcess(result: CliResult, success: boolean) {
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  expect(result.stdout.trimEnd().split("\n")).toHaveLength(1);
  expect(result.json).toMatchObject({ ok: success });
  expect(result.status === 0).toBe(success);
  return result.json!;
}

function writeNote(root: string) {
  const path = join(root, "note.md");
  writeFileSync(path, "---\ntitle: CLI Note\n---\n\n# CLI Note\n\nHello.\n");
  return path;
}

function writeInteractive(root: string, theme?: string) {
  writeFileSync(join(root, "data.json"), '{"ready":true}\n');
  writeFileSync(
    join(root, "renderer.mjs"),
    'export function renderArtifact({ data }) { return { mainSections: `<main id="ready">${data.registry.ready}</main>` }; }\n',
  );
  const manifest = join(root, "artifact.mjs");
  writeFileSync(
    manifest,
    `export default {
      contractVersion: 2,
      mode: "interactive",
      metadata: { title: "CLI Interactive", description: "Fixture", eyebrow: "Test", lang: "en" },
      dataBlocks: [{ id: "registry", source: "./data.json" }],
      renderer: "./renderer.mjs",
      styles: [], scripts: [], svgAssets: [], requiredDataBlocks: ["registry"]${
        theme === undefined ? "" : `, theme: ${JSON.stringify(theme)}`
      }
    };\n`,
  );
  return manifest;
}

describe("workspace CLI process contract", () => {
  it("prints text only for explicit help", () => {
    const root = temporaryRoot();
    const help = runExecutable(process.execPath, [workspaceCli, "--help"], root);
    expect(help.status).toBe(0);
    expect(help.stderr).toBe("");
    expect(help.json).toBeUndefined();
    expect(help.stdout).toContain("402v-html-kit build");

    const missing = runExecutable(process.execPath, [workspaceCli], root);
    expectJsonProcess(missing, false);
  });

  it.each([
    ["unknown command", ["unknown"]],
    ["unknown option", ["build", "note.md", "--wat"]],
    ["duplicate option", ["build", "note.md", "--force", "--force"]],
    ["missing value", ["build", "note.md", "--theme", "--force"]],
    ["equals smuggling", ["build", "note.md", "--output=note.html"]],
    ["option delimiter", ["build", "--", "note.md"]],
    ["oversized argv", ["build", `${"x".repeat(4097)}.md`]],
  ])("returns one structured error for %s", (_label, args) => {
    const root = temporaryRoot();
    const result = runExecutable(process.execPath, [workspaceCli, ...args], root);
    expectJsonProcess(result, false);
  });

  it("initializes deterministic contained starters and honors force", () => {
    const root = temporaryRoot();
    const first = runExecutable(
      process.execPath,
      [workspaceCli, "init", "starter", "--title", "Starter"],
      root,
    );
    const firstJson = expectJsonProcess(first, true);
    expect(firstJson.command).toBe("init");
    expect(existsSync(join(root, "starter", "note.md"))).toBe(true);
    expect(existsSync(join(root, "starter", "artifact.mjs"))).toBe(true);
    expect(existsSync(join(root, "starter", "renderer.mjs"))).toBe(true);
    expectJsonProcess(
      runExecutable(
        process.execPath,
        [
          workspaceCli,
          "build-artifact",
          "starter/artifact.mjs",
          "--output",
          "starter/interactive.html",
        ],
        root,
      ),
      true,
    );
    const before = readFileSync(join(root, "starter", "note.md"), "utf8");

    const refused = runExecutable(
      process.execPath,
      [workspaceCli, "init", "starter", "--title", "Changed"],
      root,
    );
    expectJsonProcess(refused, false);
    expect(readFileSync(join(root, "starter", "note.md"), "utf8")).toBe(before);

    const forced = runExecutable(
      process.execPath,
      [workspaceCli, "init", "starter", "--title", "Changed", "--force"],
      root,
    );
    expectJsonProcess(forced, true);
    expect(readFileSync(join(root, "starter", "note.md"), "utf8")).toContain(
      'title: "Changed"',
    );
  }, 20_000);

  it("validates an explicit theme before writing any note output", () => {
    const root = temporaryRoot();
    const input = writeNote(root);
    writeFileSync(join(root, "bad-theme.mjs"), "export default { id: 'bad' };\n");
    const output = join(root, "note.html");

    const result = runExecutable(
      process.execPath,
      [workspaceCli, "build", basename(input), "--theme", "./bad-theme.mjs"],
      root,
    );
    expect(expectJsonProcess(result, false).error.code).toBe("INVALID_THEME");
    expect(existsSync(output)).toBe(false);
  });

  it("builds a default-theme note, refuses overwrite, and verifies it", () => {
    const root = temporaryRoot();
    const input = writeNote(root);
    const output = join(root, "note.html");

    const built = runExecutable(process.execPath, [workspaceCli, "build", basename(input)], root);
    expect(expectJsonProcess(built, true)).toMatchObject({
      command: "build",
      mode: "note",
      output,
      theme: { id: "402v", version: "0.1.0" },
    });
    expect(existsSync(output)).toBe(true);

    const before = readFileSync(output);
    expectJsonProcess(
      runExecutable(process.execPath, [workspaceCli, "build", basename(input)], root),
      false,
    );
    expect(readFileSync(output)).toEqual(before);

    expect(expectJsonProcess(
      runExecutable(process.execPath, [workspaceCli, "verify", basename(output)], root),
      true,
    )).toMatchObject({ command: "verify", mode: "note", issues: [] });
  }, 15_000);

  it("uses flag over manifest and manifest over the official theme", () => {
    const root = temporaryRoot();
    writeFileSync(
      join(root, "manifest-theme.mjs"),
      `export default { themeContractVersion: 1, id: "manifest-theme", version: "1.0.0", displayName: "Manifest", render(input) { return { lang: "en", styles: "", bodyHtml: '<main data-theme="manifest">' + input.content.slots.mainSections + '</main>' }; } };\n`,
    );
    writeFileSync(
      join(root, "flag-theme.mjs"),
      `export default { themeContractVersion: 1, id: "flag-theme", version: "1.0.0", displayName: "Flag", render(input) { return { lang: "en", styles: "", bodyHtml: '<main data-theme="flag">' + input.content.slots.mainSections + '</main>' }; } };\n`,
    );
    const manifest = writeInteractive(root, "./manifest-theme.mjs");

    const selectedManifest = runExecutable(
      process.execPath,
      [workspaceCli, "build-artifact", basename(manifest), "--output", "manifest.html"],
      root,
    );
    expect(expectJsonProcess(selectedManifest, true)).toMatchObject({
      theme: { id: "manifest-theme", version: "1.0.0" },
    });

    const selectedFlag = runExecutable(
      process.execPath,
      [
        workspaceCli,
        "build-artifact",
        basename(manifest),
        "--theme",
        "./flag-theme.mjs",
        "--output",
        "flag.html",
      ],
      root,
    );
    expect(expectJsonProcess(selectedFlag, true)).toMatchObject({
      theme: { id: "flag-theme", version: "1.0.0" },
    });
    expect(expectJsonProcess(
      runExecutable(
        process.execPath,
        [workspaceCli, "verify", "flag.html", "--required-block", "registry"],
        root,
      ),
      true,
    )).toMatchObject({ command: "verify", mode: "interactive", issues: [] });
  }, 20_000);

  it("keeps Task 10 update and preserve paths behind a stable no-write gate", () => {
    const root = temporaryRoot();
    const manifest = writeInteractive(root);
    writeFileSync(join(root, "artifact.html"), "sentinel");
    writeFileSync(join(root, "input.json"), '{"ready":false}');

    const preserve = runExecutable(
      process.execPath,
      [workspaceCli, "build-artifact", basename(manifest), "--preserve-data-from", "artifact.html"],
      root,
    );
    expect(expectJsonProcess(preserve, false).error.code).toBe("COMMAND_UNAVAILABLE");
    expect(existsSync(join(root, "artifact.html"))).toBe(true);

    const update = runExecutable(
      process.execPath,
      [
        workspaceCli,
        "update-data",
        "artifact.html",
        "--manifest",
        basename(manifest),
        "--id",
        "registry",
        "--input",
        "input.json",
        "--upgrade-contract",
        "2",
      ],
      root,
    );
    expect(expectJsonProcess(update, false).error.code).toBe("COMMAND_UNAVAILABLE");
    expect(readFileSync(join(root, "artifact.html"), "utf8")).toBe("sentinel");
  });
});

describe("packed CLI binary", () => {
  let consumerRoot: string;
  let binary: string;
  let packedCliFiles: string[] = [];

  beforeAll(() => {
    const packRoot = temporaryRoot("402v-cli-pack-");
    consumerRoot = temporaryRoot("402v-cli-consumer-");
    writeFileSync(
      join(consumerRoot, "package.json"),
      '{"name":"packed-cli-consumer","private":true,"type":"module"}\n',
    );
    cpSync(join(workspaceRoot, "node_modules"), join(consumerRoot, "node_modules"), {
      recursive: true,
    });
    rmSync(join(consumerRoot, "node_modules", "@402v"), {
      force: true,
      recursive: true,
    });
    const npmEnvironment = {
      ...process.env,
      npm_config_cache: join(packRoot, "npm-cache"),
    };
    for (const workspace of [
      "@402v/html-kit-core",
      "@402v/theme-402v",
      "@402v/html-kit-cli",
    ]) {
      const packed = execFileSync(
        "npm",
        ["pack", "--json", "--workspace", workspace, "--pack-destination", packRoot],
        {
          cwd: workspaceRoot,
          encoding: "utf8",
          env: npmEnvironment,
          stdio: "pipe",
        },
      );
      if (workspace === "@402v/html-kit-cli") {
        packedCliFiles = JSON.parse(packed)[0].files.map(
          (entry: { path: string }) => entry.path,
        );
      }
    }
    const tarballs = [
      join(packRoot, "402v-html-kit-core-0.1.0.tgz"),
      join(packRoot, "402v-theme-402v-0.1.0.tgz"),
      join(packRoot, "402v-html-kit-cli-0.1.0.tgz"),
    ];
    execFileSync(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        ...tarballs,
      ],
      { cwd: consumerRoot, env: npmEnvironment, stdio: "pipe" },
    );
    binary = join(consumerRoot, "node_modules", ".bin", "402v-html-kit");
  }, 120_000);

  afterAll(() => {
    for (const root of roots.splice(0)) {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("contains only package.json and src, with an executable shebang binary", () => {
    const packedCli = join(consumerRoot, "node_modules", "@402v", "html-kit-cli");
    expect(readFileSync(join(packedCli, "src", "cli.mjs"), "utf8")).toMatch(
      /^#!\/usr\/bin\/env node\n/,
    );
    expect(statSync(binary).mode & 0o111).not.toBe(0);
    expect(packedCliFiles).toContain("package.json");
    expect(packedCliFiles.every(
      (path) => path === "package.json" || path.startsWith("src/"),
    )).toBe(true);
  });

  it("resolves packed core and the packed official default theme", () => {
    const input = writeNote(consumerRoot);
    const result = runExecutable(binary, ["build", basename(input)], consumerRoot);
    expect(expectJsonProcess(result, true)).toMatchObject({
      command: "build",
      mode: "note",
      theme: { id: "402v", version: "0.1.0" },
    });
  });
});
