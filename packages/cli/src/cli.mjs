#!/usr/bin/env node

import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { extname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ArtifactBuildError } from "@402v/html-kit-core";

const WORKER_PATH = fileURLToPath(new URL("./worker.mjs", import.meta.url));
const WORKER_TIMEOUT_MS = 30_000;
const WORKER_OUTPUT_BYTES = 1024 * 1024;
const MAX_ARG_COUNT = 64;
const MAX_ARG_BYTES = 4_096;
const MAX_TOTAL_ARG_BYTES = 32 * 1024;
const COMMANDS = new Set(["init", "build", "build-artifact", "update-data", "verify"]);

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 1 && argv[0] === "--help") {
    process.stdout.write(helpText());
    return;
  }
  try {
    const request = parse(argv, process.cwd());
    const result = await runWorker(request.command, request.options);
    writeJson(result);
  } catch (error) {
    const normalized =
      error instanceof ArtifactBuildError
        ? error
        : new ArtifactBuildError(
            "UNEXPECTED_CLI_ERROR",
            "402v HTML Kit command failed unexpectedly",
          );
    writeJson(normalized.toJSON());
    process.exitCode = 1;
  }
}

function fail(message) {
  throw new ArtifactBuildError("INVALID_CLI_ARGUMENTS", message);
}

function validateArgv(values) {
  if (values.length === 0) fail("A command is required; use --help for usage");
  if (values.length > MAX_ARG_COUNT) fail("CLI argument count exceeds the supported limit");
  let total = 0;
  for (const value of values) {
    if (typeof value !== "string" || value.includes("\0")) {
      fail("CLI arguments must be strings without NUL bytes");
    }
    const bytes = Buffer.byteLength(value, "utf8");
    total += bytes;
    if (bytes === 0 || bytes > MAX_ARG_BYTES) {
      fail("CLI argument exceeds the supported byte limit");
    }
  }
  if (total > MAX_TOTAL_ARG_BYTES) fail("CLI arguments exceed the total byte limit");
}

function parse(values, cwd) {
  validateArgv(values);
  const command = values[0];
  if (!COMMANDS.has(command)) fail(`Unknown command: ${command}`);
  const parsed = parseCommand(command, values.slice(1));
  const baseDirectory = resolve(cwd);

  if (command === "init") {
    return {
      command,
      options: {
        baseDirectory,
        directory: resolve(cwd, parsed.positionals[0]),
        force: parsed.force,
        title: parsed.title,
        ...(parsed.theme === undefined ? {} : { theme: parsed.theme }),
      },
    };
  }
  if (command === "build") {
    const inputPath = resolve(cwd, parsed.positionals[0]);
    const outputPath = resolve(
      cwd,
      parsed.output ?? inputPath.replace(/\.md$/i, ".html"),
    );
    return {
      command,
      options: {
        baseDirectory,
        force: parsed.force,
        inputPath,
        outputPath,
        ...(parsed.theme === undefined ? {} : { theme: parsed.theme }),
      },
    };
  }
  if (command === "build-artifact") {
    const manifestPath = resolve(cwd, parsed.positionals[0]);
    const outputPath = resolve(
      cwd,
      parsed.output ?? manifestPath.replace(/\.[^.\/]+$/u, ".html"),
    );
    return {
      command,
      options: {
        baseDirectory,
        force: parsed.force,
        manifestPath,
        outputPath,
        ...(parsed.theme === undefined ? {} : { theme: parsed.theme }),
        ...(parsed.preserveDataFrom === undefined
          ? {}
          : { preserveDataFrom: resolve(cwd, parsed.preserveDataFrom) }),
      },
    };
  }
  if (command === "update-data") {
    return {
      command,
      options: {
        artifactPath: resolve(cwd, parsed.positionals[0]),
        baseDirectory,
        force: parsed.force,
        id: parsed.id,
        inputPath: resolve(cwd, parsed.input),
        manifestPath: resolve(cwd, parsed.manifest),
        ...(parsed.output === undefined ? {} : { outputPath: resolve(cwd, parsed.output) }),
        ...(parsed.theme === undefined ? {} : { theme: parsed.theme }),
        ...(parsed.upgradeContract === undefined
          ? {}
          : { upgradeContract: 2 }),
      },
    };
  }
  return {
    command,
    options: {
      path: resolve(cwd, parsed.positionals[0]),
      requiredDataBlocks: parsed.requiredBlock,
    },
  };
}

const SCHEMAS = Object.freeze({
  init: {
    values: new Set(["title", "theme"]),
    booleans: new Set(["force"]),
    repeat: new Set(),
    required: new Set(["title"]),
  },
  build: {
    values: new Set(["theme", "output"]),
    booleans: new Set(["force"]),
    repeat: new Set(),
    required: new Set(),
  },
  "build-artifact": {
    values: new Set(["theme", "output", "preserveDataFrom"]),
    booleans: new Set(["force"]),
    repeat: new Set(),
    required: new Set(),
  },
  "update-data": {
    values: new Set(["manifest", "id", "input", "theme", "output", "upgradeContract"]),
    booleans: new Set(["force"]),
    repeat: new Set(),
    required: new Set(["manifest", "id", "input"]),
  },
  verify: {
    values: new Set(),
    booleans: new Set(),
    repeat: new Set(["requiredBlock"]),
    required: new Set(),
  },
});

const FLAG_TO_PROPERTY = Object.freeze({
  "--title": "title",
  "--theme": "theme",
  "--output": "output",
  "--preserve-data-from": "preserveDataFrom",
  "--manifest": "manifest",
  "--id": "id",
  "--input": "input",
  "--upgrade-contract": "upgradeContract",
  "--required-block": "requiredBlock",
  "--force": "force",
});

function parseCommand(command, args) {
  const schema = SCHEMAS[command];
  const parsed = { positionals: [], force: false, requiredBlock: [] };
  const seen = new Set();
  for (let cursor = 0; cursor < args.length; cursor += 1) {
    const token = args[cursor];
    if (token.startsWith("-")) {
      const property = FLAG_TO_PROPERTY[token];
      if (property === undefined) fail(`Unsupported option for ${command}: ${token}`);
      if (schema.booleans.has(property)) {
        if (seen.has(property)) fail(`${token} may only be provided once`);
        seen.add(property);
        parsed[property] = true;
        continue;
      }
      if (!schema.values.has(property) && !schema.repeat.has(property)) {
        fail(`Unsupported option for ${command}: ${token}`);
      }
      const value = args[cursor + 1];
      if (value === undefined || value.startsWith("-")) fail(`${token} requires a value`);
      cursor += 1;
      if (schema.repeat.has(property)) {
        if (parsed[property].includes(value)) fail(`${token} values must be unique`);
        parsed[property].push(value);
      } else {
        if (seen.has(property)) fail(`${token} may only be provided once`);
        seen.add(property);
        parsed[property] = value;
      }
    } else {
      parsed.positionals.push(token);
    }
  }
  if (parsed.positionals.length !== 1) fail(`${command} requires exactly one input path`);
  for (const property of schema.required) {
    if (!seen.has(property)) fail(`--${property} is required`);
  }
  if (parsed.upgradeContract !== undefined && parsed.upgradeContract !== "2") {
    fail("--upgrade-contract only accepts 2");
  }
  return parsed;
}

function runWorker(command, options) {
  const token = randomBytes(32).toString("hex");
  const child = fork(WORKER_PATH, [], {
    cwd: process.cwd(),
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let discarded = 0;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeAllListeners();
      child.stdout?.removeAllListeners();
      child.stderr?.removeAllListeners();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      callback(value);
    };
    const reject = (code, message) =>
      finish(rejectPromise, new ArtifactBuildError(code, message));
    const discard = (chunk) => {
      discarded += Buffer.byteLength(chunk);
      if (discarded > WORKER_OUTPUT_BYTES) {
        reject("CLI_WORKER_OUTPUT_LIMIT", "CLI worker exceeded its output limit");
      }
    };
    child.stdout?.on("data", discard);
    child.stderr?.on("data", discard);
    child.once("error", () => reject("CLI_WORKER_FAILED", "CLI worker could not be started"));
    child.once("exit", () => reject("CLI_WORKER_FAILED", "CLI worker exited without a result"));
    child.on("message", (message) => {
      if (!validEnvelope(message, token)) return;
      if (message.kind === "result") finish(resolvePromise, message.payload);
      else finish(
        rejectPromise,
        new ArtifactBuildError(
          message.payload.code,
          message.payload.message,
          message.payload.details,
        ),
      );
    });
    const timer = setTimeout(
      () => reject("CLI_WORKER_TIMEOUT", "CLI worker exceeded its time limit"),
      WORKER_TIMEOUT_MS,
    );
    timer.unref();
    child.send({ token, command, options }, (error) => {
      if (error !== null) reject("CLI_WORKER_FAILED", "CLI request could not be delivered");
    });
  });
}

function validEnvelope(value, token) {
  if (
    value === null ||
    typeof value !== "object" ||
    value.token !== token ||
    (value.kind !== "result" && value.kind !== "error") ||
    value.payload === null ||
    typeof value.payload !== "object"
  ) return false;
  return value.kind === "result"
    ? value.payload.ok === true
    : typeof value.payload.code === "string" && typeof value.payload.message === "string";
}

function writeJson(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function helpText() {
  return `402v HTML Kit\n\nUsage:\n  402v-html-kit init <directory> --title <title> [--theme <specifier>] [--force]\n  402v-html-kit build <input.md> [--theme <specifier>] [--output <html>] [--force]\n  402v-html-kit build-artifact <manifest.mjs> [--theme <specifier>] [--output <html>] [--preserve-data-from <html>] [--force]\n  402v-html-kit update-data <artifact.html> --manifest <manifest.mjs> --id <id> --input <json> [--theme <specifier>] [--output <html>] [--upgrade-contract 2] [--force]\n  402v-html-kit verify <artifact.html> [--required-block <id>]...\n`;
}

await main();
