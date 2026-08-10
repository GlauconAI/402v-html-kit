import { execFileSync, fork, spawnSync } from "node:child_process";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const cliPackage = fileURLToPath(new URL("../package.json", import.meta.url));
const workspaceRoot = resolve(dirname(cliPackage), "../..");
const workspaceCli = join(dirname(cliPackage), "src", "cli.mjs");
const workspaceWorker = join(dirname(cliPackage), "src", "worker.mjs");
const v1Interactive = join(
  workspaceRoot,
  "tests",
  "compatibility",
  "fixtures",
  "v1",
  "interactive.html",
);
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

function cacheContentPath(cacheRoot: string, integrity: string) {
  const match = integrity.match(/^([a-z0-9]+)-(.+)$/i);
  if (match === null) throw new Error(`Unsupported lock integrity: ${integrity}`);
  const hex = Buffer.from(match[2], "base64").toString("hex");
  return join(
    cacheRoot,
    "_cacache",
    "content-v2",
    match[1],
    hex.slice(0, 2),
    hex.slice(2, 4),
    hex.slice(4),
  );
}

function prepareCleanOfflineConsumer(options: {
  consumerRoot: string;
  npmCache: string;
  packed: Map<string, any>;
  packRoot: string;
}) {
  const sourceLock = JSON.parse(
    readFileSync(join(workspaceRoot, "package-lock.json"), "utf8"),
  );
  const hostCache = execFileSync("npm", ["config", "get", "cache"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const packages: Record<string, any> = {};

  // npm ci can consume exact registry tarballs by lock integrity without a
  // packument. Copy only production graph content-addressed blobs into the
  // task-private cache; never seed node_modules, symlinks, or NODE_PATH.
  for (const [path, entry] of Object.entries<any>(sourceLock.packages)) {
    if (
      !path.startsWith("node_modules/") ||
      path.startsWith("node_modules/@402v/") ||
      entry.dev === true
    ) {
      continue;
    }
    const source = cacheContentPath(hostCache, entry.integrity);
    const destination = cacheContentPath(options.npmCache, entry.integrity);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    packages[path] = entry;
  }

  const packageSpecs: Record<string, string> = {};
  for (const [name, details] of options.packed) {
    packageSpecs[name] = `file:${relative(
      options.consumerRoot,
      join(options.packRoot, details.filename),
    )}`;
  }
  const manifests = new Map([
    ["@402v/html-kit-core", JSON.parse(readFileSync(join(workspaceRoot, "packages/core/package.json"), "utf8"))],
    ["@402v/theme-402v", JSON.parse(readFileSync(join(workspaceRoot, "packages/theme-402v/package.json"), "utf8"))],
    ["@402v/html-kit-cli", JSON.parse(readFileSync(join(workspaceRoot, "packages/cli/package.json"), "utf8"))],
  ]);
  for (const [name, manifest] of manifests) {
    const details = options.packed.get(name);
    packages[`node_modules/${name}`] = {
      version: manifest.version,
      resolved: packageSpecs[name],
      integrity: details.integrity,
      license: manifest.license,
      ...(manifest.dependencies === undefined
        ? {}
        : { dependencies: manifest.dependencies }),
      ...(manifest.bin === undefined ? {} : { bin: manifest.bin }),
      ...(manifest.engines === undefined ? {} : { engines: manifest.engines }),
    };
  }
  packages[""] = {
    name: "packed-cli-consumer",
    dependencies: packageSpecs,
  };
  writeFileSync(
    join(options.consumerRoot, "package.json"),
    `${JSON.stringify({
      name: "packed-cli-consumer",
      private: true,
      type: "module",
      dependencies: packageSpecs,
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(options.consumerRoot, "package-lock.json"),
    `${JSON.stringify({
      name: "packed-cli-consumer",
      lockfileVersion: 3,
      requires: true,
      packages,
    }, null, 2)}\n`,
  );
}

function workerRequest(command: string, options: Record<string, unknown>) {
  const token = "a".repeat(64);
  const child = fork(workspaceWorker, [], {
    cwd: workspaceRoot,
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return new Promise<Record<string, any>>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      rejectPromise(new Error("worker request timed out"));
    }, 10_000);
    child.once("error", rejectPromise);
    child.on("message", (message: any) => {
      if (message?.token !== token) return;
      clearTimeout(timeout);
      child.kill("SIGKILL");
      resolvePromise(message);
    });
    child.send({ token, command, options });
  });
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

  it("keeps preserve unavailable and gates corrupt v1 before imports or input", () => {
    const root = temporaryRoot();
    const manifest = writeInteractive(root);
    const fixture = readFileSync(v1Interactive, "utf8");
    const corrupted = fixture.replace('"name": "Agent Atlas"', '"name": "Agent AtlaX"');
    expect(corrupted).not.toBe(fixture);
    writeFileSync(join(root, "artifact.html"), corrupted);
    const before = readFileSync(join(root, "artifact.html"));
    const marker = join(root, "manifest-imported");
    writeFileSync(
      manifest,
      `import { writeFileSync } from "node:fs";
       writeFileSync(${JSON.stringify(marker)}, "yes");
       export default {};`,
    );

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
        "project-registry",
        "--input",
        "missing-input.json",
      ],
      root,
    );
    expect(expectJsonProcess(update, false).error.code).toBe("CONTRACT_UPGRADE_REQUIRED");
    expect(existsSync(marker)).toBe(false);
    expect(readFileSync(join(root, "artifact.html"))).toEqual(before);
  });

  it("updates contract-v2 data through the CLI", () => {
    const root = temporaryRoot();
    const manifest = writeInteractive(root);
    expectJsonProcess(
      runExecutable(
        process.execPath,
        [workspaceCli, "build-artifact", basename(manifest)],
        root,
      ),
      true,
    );
    writeFileSync(join(root, "input.json"), '{"ready":false,"source":"cli"}');

    const update = expectJsonProcess(
      runExecutable(
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
        ],
        root,
      ),
      true,
    );
    expect(update).toMatchObject({
      command: "update-data",
      oldContract: 2,
      newContract: 2,
      theme: { id: "402v", version: "0.1.0" },
      outputPath: join(root, "artifact.html"),
    });
    expect(readFileSync(join(root, "artifact.html"), "utf8")).toContain(
      '"source": "cli"',
    );
  }, 20_000);

  it("bounds every direct worker string before pending or verify execution", async () => {
    const root = temporaryRoot();
    const oversized = "x".repeat(4_097);
    const verify = await workerRequest("verify", {
      path: join(root, "artifact.html"),
      requiredDataBlocks: [oversized],
    });
    expect(verify).toMatchObject({
      kind: "error",
      payload: { code: "INVALID_CLI_ARGUMENTS" },
    });

    const update = await workerRequest("update-data", {
      artifactPath: join(root, "artifact.html"),
      baseDirectory: root,
      force: "yes",
      id: oversized,
      inputPath: join(root, "input.json"),
      manifestPath: join(root, "artifact.mjs"),
    });
    expect(update).toMatchObject({
      kind: "error",
      payload: { code: "INVALID_CLI_ARGUMENTS" },
    });
  });

  it("does not clobber a no-force starter destination created during installation", () => {
    const root = temporaryRoot();
    const target = join(root, "starter");
    const attacker = "attacker-owned\n";
    writeFileSync(
      join(root, "racing-theme.mjs"),
      `import { spawn } from "node:child_process";
       export default {
         themeContractVersion: 1, id: "racing-theme", version: "1.0.0", displayName: "Race",
         render() {
           const code = ${JSON.stringify(
             'const { existsSync, writeFileSync } = require("node:fs"); const { join } = require("node:path"); const root = process.argv[1]; while (!existsSync(join(root, "note.md"))) {} try { writeFileSync(join(root, "renderer.mjs"), "attacker-owned\\n", { flag: "wx" }); } catch {}',
           )};
           spawn(process.execPath, ["-e", code, ${JSON.stringify(target)}], { stdio: "ignore" });
           Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
           return { lang: "en", styles: "", bodyHtml: "<main></main>" };
         }
       };\n`,
    );

    const result = runExecutable(
      process.execPath,
      [
        workspaceCli,
        "init",
        "starter",
        "--title",
        "Race",
        "--theme",
        "./racing-theme.mjs",
      ],
      root,
    );
    expect(expectJsonProcess(result, false).error.code).toBe("OUTPUT_EXISTS");
    expect(readFileSync(join(target, "renderer.mjs"), "utf8")).toBe(attacker);
  }, 20_000);
});

describe("packed CLI binary", () => {
  let consumerRoot: string;
  let binary: string;
  let packedCliFiles: string[] = [];

  beforeAll(() => {
    const packRoot = temporaryRoot("402v-cli-pack-");
    consumerRoot = temporaryRoot("402v-cli-consumer-");
    expect(existsSync(join(consumerRoot, "node_modules"))).toBe(false);
    const npmEnvironment = {
      ...process.env,
      NODE_PATH: "",
      npm_config_cache: join(packRoot, "npm-cache"),
    };
    const packedDetails = new Map<string, any>();
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
      packedDetails.set(workspace, JSON.parse(packed)[0]);
    }
    prepareCleanOfflineConsumer({
      consumerRoot,
      npmCache: npmEnvironment.npm_config_cache,
      packed: packedDetails,
      packRoot,
    });
    execFileSync(
      "npm",
      [
        "ci",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
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
    const packedManifest = JSON.parse(
      readFileSync(join(packedCli, "package.json"), "utf8"),
    );
    expect(packedManifest.dependencies.acorn).toBe("^8.15.0");
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
    for (const name of ["html-kit-core", "html-kit-cli", "theme-402v"]) {
      expect(
        realpathSync(join(consumerRoot, "node_modules", "@402v", name)).startsWith(
          `${consumerRoot}/`,
        ),
      ).toBe(true);
    }
    const input = writeNote(consumerRoot);
    const result = runExecutable(binary, ["build", basename(input)], consumerRoot);
    expect(expectJsonProcess(result, true)).toMatchObject({
      command: "build",
      mode: "note",
      theme: { id: "402v", version: "0.1.0" },
    });
  });

  it("updates data through the packed CLI", () => {
    const manifest = writeInteractive(consumerRoot);
    expectJsonProcess(
      runExecutable(binary, ["build-artifact", basename(manifest)], consumerRoot),
      true,
    );
    writeFileSync(join(consumerRoot, "input.json"), '{"ready":false}');
    const result = runExecutable(
      binary,
      [
        "update-data",
        "artifact.html",
        "--manifest",
        basename(manifest),
        "--id",
        "registry",
        "--input",
        "input.json",
      ],
      consumerRoot,
    );
    expect(expectJsonProcess(result, true)).toMatchObject({
      command: "update-data",
      oldContract: 2,
      newContract: 2,
    });
  }, 30_000);
});
