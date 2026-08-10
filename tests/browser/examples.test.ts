import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CdpConnection,
  launchChrome,
  stopChrome,
} from "./chrome-harness.mjs";

const workspaceRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const sourceExamplesRoot = join(workspaceRoot, "examples");
const exampleSourceFiles = Object.freeze([
  ["note", "input.md"],
  ["interactive", "artifact.mjs"],
  ["interactive", "data.json"],
  ["interactive", "renderer.mjs"],
  ["custom-theme", "artifact-theme.mjs"],
  ["custom-theme", "input.md"],
] as const);
const exampleCases = Object.freeze([
  {
    name: "note",
    relativeDirectory: "note",
    buildArgs: ["build", "input.md", "--output", "output.html"],
    verifyArgs: ["verify", "output.html"],
  },
  {
    name: "interactive",
    relativeDirectory: "interactive",
    buildArgs: ["build-artifact", "artifact.mjs", "--output", "output.html"],
    verifyArgs: ["verify", "output.html", "--required-block", "dashboard"],
  },
  {
    name: "custom-theme",
    relativeDirectory: "custom-theme",
    buildArgs: [
      "build",
      "input.md",
      "--theme",
      "./artifact-theme.mjs",
      "--output",
      "output.html",
    ],
    verifyArgs: ["verify", "output.html"],
  },
] as const);

type CliResult = {
  error?: Error;
  status: number | null;
  stderr: string;
  stdout: string;
};

type ExampleResult = {
  name: string;
  outputPath: string;
  firstHash: string;
  secondHash: string;
  verification: Record<string, unknown>;
};

type CdpEvent = {
  method: string;
  params?: Record<string, unknown>;
  sessionId?: string;
};

const temporaryRoots: string[] = [];
const builtExamples: ExampleResult[] = [];
let binary = "";
let browser: Awaited<ReturnType<typeof launchChrome>> | undefined;
let cleanConsumerRoot = "";
let cleanThemeDirectory = "";
let cleanExamplesRoot = "";

function temporaryRoot(label: string) {
  const root = mkdtempSync(join(tmpdir(), label));
  temporaryRoots.push(root);
  return root;
}

function run(
  executable: string,
  args: readonly string[],
  cwd: string,
  timeout = 60_000,
  environment: Record<string, string> = {},
) {
  return spawnSync(executable, [...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      NODE_PATH: "",
      NO_COLOR: "1",
      npm_config_offline: "true",
      ...environment,
    },
    timeout,
  }) as unknown as CliResult;
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

function successfulJson(result: CliResult) {
  expect(result.error).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.endsWith("\n")).toBe(true);
  const lines = result.stdout.trimEnd().split("\n");
  expect(lines).toHaveLength(1);
  const parsed = JSON.parse(lines[0]);
  expect(parsed).toMatchObject({ ok: true });
  return parsed as Record<string, unknown>;
}

function digest(path: string) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function contained(root: string, candidate: string) {
  const difference = relative(root, candidate);
  return difference === "" || (
    !isAbsolute(difference) &&
    difference !== ".." &&
    !difference.startsWith(`..${sep}`)
  );
}

function preparePackedCli() {
  const packRoot = temporaryRoot("402v-examples-pack-");
  const consumerRoot = temporaryRoot("402v-examples-consumer-");
  cleanConsumerRoot = consumerRoot;
  const npmCache = join(packRoot, "npm-cache");
  const dependencies: Record<string, string> = {};
  const packedDetails = new Map<string, Record<string, string>>();
  for (const workspace of [
    "@402v/html-kit-core",
    "@402v/theme-402v",
    "@402v/html-kit-cli",
  ]) {
    const packed = run(
      "npm",
      [
        "pack",
        "--json",
        "--workspace",
        workspace,
        "--pack-destination",
        packRoot,
      ],
      workspaceRoot,
      120_000,
      { npm_config_cache: npmCache },
    );
    expect(packed.error).toBeUndefined();
    expect(packed.status).toBe(0);
    expect(packed.stderr).toBe("");
    const details = JSON.parse(packed.stdout)[0];
    packedDetails.set(workspace, details);
    dependencies[workspace] = `file:${relative(
      consumerRoot,
      join(packRoot, details.filename),
    )}`;
  }

  const sourceLock = JSON.parse(
    readFileSync(join(workspaceRoot, "package-lock.json"), "utf8"),
  );
  const hostCache = execFileSync("npm", ["config", "get", "cache"], {
    cwd: workspaceRoot,
    encoding: "utf8",
  }).trim();
  const packages: Record<string, unknown> = {};
  for (const [path, entry] of Object.entries<any>(sourceLock.packages)) {
    if (
      !path.startsWith("node_modules/") ||
      path.startsWith("node_modules/@402v/") ||
      entry.dev === true
    ) {
      continue;
    }
    const source = cacheContentPath(hostCache, entry.integrity);
    const destination = cacheContentPath(npmCache, entry.integrity);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    packages[path] = entry;
  }
  for (const workspace of [
    "@402v/html-kit-core",
    "@402v/theme-402v",
    "@402v/html-kit-cli",
  ]) {
    const name = workspace.slice("@402v/".length);
    const manifest = JSON.parse(
      readFileSync(join(workspaceRoot, "packages", name.replace("html-kit-", ""), "package.json"), "utf8"),
    );
    const details = packedDetails.get(workspace)!;
    packages[`node_modules/${workspace}`] = {
      version: manifest.version,
      resolved: dependencies[workspace],
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
    name: "html-kit-examples-consumer",
    dependencies,
  };
  writeFileSync(
    join(consumerRoot, "package.json"),
    `${JSON.stringify({
      name: "html-kit-examples-consumer",
      private: true,
      type: "module",
      dependencies,
    }, null, 2)}\n`,
  );
  writeFileSync(
    join(consumerRoot, "package-lock.json"),
    `${JSON.stringify({
      name: "html-kit-examples-consumer",
      lockfileVersion: 3,
      requires: true,
      packages,
    }, null, 2)}\n`,
  );
  const installed = run(
    "npm",
    ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund"],
    consumerRoot,
    120_000,
    { npm_config_cache: npmCache },
  );
  expect(installed.error).toBeUndefined();
  expect(installed.status).toBe(0);
  expect(installed.stderr).toBe("");
  expect(existsSync(join(consumerRoot, "node_modules"))).toBe(true);
  for (const name of ["html-kit-core", "html-kit-cli", "theme-402v"]) {
    const packageDirectory = realpathSync(
      join(consumerRoot, "node_modules", "@402v", name),
    );
    expect(
      contained(consumerRoot, packageDirectory),
    ).toBe(true);
  }
  cleanThemeDirectory = join(
    consumerRoot,
    "node_modules",
    "@402v",
    "theme-402v",
  );
  cleanExamplesRoot = join(consumerRoot, "examples");
  for (const [directory, name] of exampleSourceFiles) {
    const destinationDirectory = join(cleanExamplesRoot, directory);
    mkdirSync(destinationDirectory, { recursive: true });
    copyFileSync(
      join(sourceExamplesRoot, directory, name),
      join(destinationDirectory, name),
    );
  }
  const consumerBinary = join(
    consumerRoot,
    "node_modules",
    ".bin",
    "402v-html-kit",
  );
  expect(contained(consumerRoot, realpathSync(consumerBinary))).toBe(true);
  return consumerBinary;
}

function buildExamples() {
  for (const example of exampleCases) {
    const directory = join(cleanExamplesRoot, example.relativeDirectory);
    const outputPath = join(directory, "output.html");
    expect(existsSync(outputPath)).toBe(false);

    successfulJson(run(binary, example.buildArgs, directory));
    const firstHash = digest(outputPath);
    successfulJson(run(binary, [...example.buildArgs, "--force"], directory));
    const secondHash = digest(outputPath);
    const verification = successfulJson(
      run(binary, example.verifyArgs, directory),
    );
    builtExamples.push({
      name: example.name,
      outputPath,
      firstHash,
      secondHash,
      verification,
    });
  }
}

function waitForEvent(
  connection: CdpConnection,
  sessionId: string,
  method: string,
  timeoutMs = 10_000,
) {
  return new Promise<void>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => {
      stop();
      rejectPromise(new Error(`Timed out waiting for ${method}`));
    }, timeoutMs);
    const stop = connection.onEvent((event: CdpEvent) => {
      if (event.sessionId !== sessionId || event.method !== method) return;
      clearTimeout(timeout);
      stop();
      resolvePromise();
    });
  });
}

async function inspectFile(
  connection: CdpConnection,
  outputPath: string,
  viewport: { width: number; height: number },
) {
  const { targetId } = await connection.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await connection.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const externalRequests: string[] = [];
  const pageErrors: string[] = [];
  const stopListening = connection.onEvent((event: CdpEvent) => {
    if (event.sessionId !== sessionId) return;
    if (event.method === "Network.requestWillBeSent") {
      const request = event.params?.request as { url?: string } | undefined;
      const url = request?.url ?? "unknown request";
      if (/^(?:https?|wss?):/i.test(url)) externalRequests.push(url);
    }
    if (event.method === "Runtime.exceptionThrown") {
      pageErrors.push(JSON.stringify(event.params));
    }
    if (event.method === "Log.entryAdded") {
      const entry = event.params?.entry as { level?: string; text?: string } | undefined;
      if (entry?.level === "error") pageErrors.push(entry.text ?? "page log error");
    }
    if (event.method === "Runtime.consoleAPICalled") {
      const type = event.params?.type;
      if (type === "error" || type === "assert") {
        pageErrors.push(`console.${String(type)}`);
      }
    }
  });

  try {
    await Promise.all([
      connection.send("Page.enable", {}, sessionId),
      connection.send("Runtime.enable", {}, sessionId),
      connection.send("Network.enable", {}, sessionId),
      connection.send("Log.enable", {}, sessionId),
    ]);
    await connection.send(
      "Emulation.setDeviceMetricsOverride",
      { ...viewport, deviceScaleFactor: 1, mobile: viewport.width <= 390 },
      sessionId,
    );
    const loaded = waitForEvent(connection, sessionId, "Page.loadEventFired");
    await connection.send(
      "Page.navigate",
      { url: pathToFileURL(outputPath).href },
      sessionId,
    );
    await loaded;
    const evaluation = await connection.send(
      "Runtime.evaluate",
      {
        awaitPromise: true,
        returnByValue: true,
        expression: `(async () => {
          await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const root = document.documentElement;
          const body = document.body;
          return {
            contract: document.querySelector('meta[name="html-kit-artifact-contract"]')?.getAttribute('content'),
            pageScrollWidth: Math.max(root.scrollWidth, body.scrollWidth),
            viewportWidth: root.clientWidth,
          };
        })()`,
      },
      sessionId,
    );
    return {
      metrics: evaluation.result.value as {
        contract: string;
        pageScrollWidth: number;
        viewportWidth: number;
      },
      externalRequests,
      pageErrors,
    };
  } finally {
    stopListening();
    await connection.send("Target.closeTarget", { targetId });
  }
}

describe.sequential("packed offline examples", () => {
  beforeAll(async () => {
    binary = preparePackedCli();
    buildExamples();
  }, 180_000);

  afterAll(async () => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds and verifies every example twice with identical bytes", () => {
    expect(builtExamples.map((example) => example.name)).toEqual([
      "note",
      "interactive",
      "custom-theme",
    ]);
    for (const example of builtExamples) {
      expect(example.firstHash).toBe(example.secondHash);
      expect(example.verification).toMatchObject({
        ok: true,
        command: "verify",
        contractVersion: 2,
        issues: [],
      });
    }
    for (const name of ["note", "interactive"]) {
      const example = builtExamples.find((candidate) => candidate.name === name)!;
      expect(readFileSync(example.outputPath, "utf8")).toContain(
        '<meta name="html-kit-theme-id" content="402v">',
      );
    }
  });

  it("builds only from a copied example tree inside the clean consumer", () => {
    expect(
      builtExamples.every((example) => contained(cleanConsumerRoot, example.outputPath)),
    ).toBe(true);
    expect(contained(cleanConsumerRoot, realpathSync(cleanThemeDirectory))).toBe(true);
    for (const example of exampleSourceFiles) {
      expect(existsSync(join(cleanExamplesRoot, ...example))).toBe(true);
    }
  });

  it("keeps the custom theme independent from 402v presentation identifiers", () => {
    const html = readFileSync(
      join(cleanExamplesRoot, "custom-theme", "output.html"),
      "utf8",
    );
    expect(html).not.toMatch(/402v\.com|__402vArtifact|data-402v-|--accent/);
    expect(html).toContain("__htmlKitArtifact");
    expect(html).toContain('content="paper"');
  });

  it("cannot resolve the official theme from the host workspace", () => {
    const unavailable = `${cleanThemeDirectory}.unavailable`;
    renameSync(cleanThemeDirectory, unavailable);
    try {
      const probes = [
        {
          args: [
            "build",
            "input.md",
            "--output",
            join(cleanConsumerRoot, "host-fallback-note.html"),
          ],
          directory: join(cleanExamplesRoot, "note"),
        },
        {
          args: [
            "build-artifact",
            "artifact.mjs",
            "--output",
            join(cleanConsumerRoot, "host-fallback-interactive.html"),
          ],
          directory: join(cleanExamplesRoot, "interactive"),
        },
      ];
      for (const probe of probes) {
        const result = run(binary, probe.args, probe.directory);
        expect(result.status).not.toBe(0);
        expect(result.stdout).toContain("THEME_RESOLUTION_FAILED");
      }
    } finally {
      renameSync(unavailable, cleanThemeDirectory);
    }
  });

  describe("real Chrome file acceptance", () => {
    beforeAll(async () => {
      browser = await launchChrome();
    }, 20_000);

    afterAll(async () => {
      if (browser !== undefined) await stopChrome(browser);
    });

    it.each(
      exampleCases.flatMap((example) => [
        [example.name, example.relativeDirectory, 1280, 900] as const,
        [example.name, example.relativeDirectory, 390, 844] as const,
      ]),
    )(
      "opens %s via file:// at %sx%s without external requests, errors, or overflow",
      async (_name, relativeDirectory, width, height) => {
        if (browser === undefined) throw new Error("Chrome did not start");
        const inspected = await inspectFile(
          browser.connection,
          join(cleanExamplesRoot, relativeDirectory, "output.html"),
          { width, height },
        );
        expect(inspected.metrics.contract).toBe("2");
        expect(inspected.metrics.pageScrollWidth).toBeLessThanOrEqual(
          inspected.metrics.viewportWidth,
        );
        expect(inspected.externalRequests).toEqual([]);
        expect(inspected.pageErrors).toEqual([]);
      },
      20_000,
    );
  });
});
