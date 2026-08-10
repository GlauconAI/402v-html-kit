import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SEMVER_NUMBER = "(?:0|[1-9][0-9]*)";
const EXACT_TAG = new RegExp(`^v(${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER})$`, "u");
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const PACKAGES = [
  { name: "@402v/html-kit-core", workspace: "packages/core" },
  { name: "@402v/theme-402v", workspace: "packages/theme-402v" },
  { name: "@402v/html-kit-cli", workspace: "packages/cli" },
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyTagIdentity({ eventSha, fetchJson, gitHead, repository, tag }) {
  const match = EXACT_TAG.exec(tag ?? "");
  invariant(match, `Release tag must be exact vX.Y.Z: ${tag ?? "<missing>"}`);
  invariant(eventSha && gitHead && eventSha === gitHead, "Checked-out HEAD must equal the release event SHA");
  invariant(repository, "GitHub repository is required");

  const api = `https://api.github.com/repos/${repository}`;
  const ref = await fetchJson(`${api}/git/ref/tags/${encodeURIComponent(tag)}`);
  invariant(ref?.object?.type === "tag", "Release tag must be annotated, not lightweight");
  invariant(typeof ref.object.sha === "string", "Annotated tag object SHA is missing");

  const tagObject = await fetchJson(`${api}/git/tags/${ref.object.sha}`);
  invariant(tagObject?.tag === tag, "Annotated tag name does not match the pushed ref");
  invariant(tagObject?.verification?.verified === true, `GitHub did not verify the tag signature: ${tagObject?.verification?.reason ?? "unknown"}`);
  invariant(tagObject?.object?.type === "commit", "Annotated release tag must target a commit");
  invariant(tagObject.object.sha === eventSha && tagObject.object.sha === gitHead, "Annotated tag target must equal the release event SHA and checked-out HEAD");

  return { commit: gitHead, version: match[1] };
}

function sri(bytes) {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

export async function validatePreparedArtifacts({ gate, packs, version }) {
  invariant(gate?.ok === true && Array.isArray(gate.packages), "pack:check did not return a successful package gate");
  invariant(Array.isArray(packs) && packs.length === PACKAGES.length, "All three release tarballs must be prepared before publishing");
  const gateByName = new Map(gate.packages.map((entry) => [entry.name, entry]));
  const packByName = new Map(packs.map((entry) => [entry.name, entry]));
  invariant(gateByName.size === PACKAGES.length, "pack:check must verify exactly the three release packages");
  invariant(packByName.size === PACKAGES.length, "npm pack must prepare exactly the three release packages");

  return PACKAGES.map(({ name }) => {
    const expected = gateByName.get(name);
    const pack = packByName.get(name);
    invariant(expected && pack, `Missing prepared release data for ${name}`);
    invariant(pack.version === version, `${name} has version ${pack.version}; expected ${version}`);
    invariant(pack.filename === expected.filename, `${name} tarball filename differs from pack:check`);
    invariant(pack.integrity === expected.integrity, `${name} tarball integrity differs from pack:check`);
    invariant(pack.integrity === sri(pack.bytes), `${name} tarball bytes do not match npm pack integrity`);
    invariant(basename(pack.path) === pack.filename, `${name} tarball path does not match its filename`);
    return {
      name,
      version,
      filename: pack.filename,
      integrity: pack.integrity,
      path: pack.path,
    };
  });
}

function verifyRegistryDist(artifact, dist, { allowPending }) {
  if (dist == null) return allowPending ? false : null;
  invariant(dist.integrity === artifact.integrity, `${artifact.name}@${artifact.version} registry integrity does not match the prepared tarball`);
  const predicate = dist.attestations?.provenance?.predicateType;
  if (predicate !== PROVENANCE_PREDICATE) {
    if (allowPending) return false;
    throw new Error(`${artifact.name}@${artifact.version} is missing required SLSA v1 provenance`);
  }
  return true;
}

export async function publishResumably({ artifacts, lookup, publish, sleep, maxPolls = 12 }) {
  invariant(Number.isInteger(maxPolls) && maxPolls > 0, "maxPolls must be a positive integer");
  for (const artifact of artifacts) {
    const existing = await lookup(artifact.name, artifact.version);
    if (existing != null) {
      verifyRegistryDist(artifact, existing, { allowPending: false });
      continue;
    }

    await publish(artifact.path);
    let latest = null;
    for (let attempt = 0; attempt < maxPolls; attempt += 1) {
      latest = await lookup(artifact.name, artifact.version);
      if (verifyRegistryDist(artifact, latest, { allowPending: true })) break;
      if (attempt + 1 < maxPolls) await sleep();
    }
    if (!verifyRegistryDist(artifact, latest, { allowPending: true })) {
      throw new Error(`${artifact.name}@${artifact.version} did not expose matching integrity and SLSA v1 provenance within the bounded poll window`);
    }
  }
}

function requiredEnvironment(name) {
  const value = process.env[name];
  invariant(value, `${name} is required`);
  return value;
}

async function githubJson(url) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${requiredEnvironment("GH_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  invariant(response.ok, `GitHub API request failed (${response.status}) for ${url}`);
  return response.json();
}

async function verifyTagCommand() {
  const result = await verifyTagIdentity({
    eventSha: requiredEnvironment("EVENT_SHA"),
    fetchJson: githubJson,
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    repository: requiredEnvironment("REPOSITORY"),
    tag: requiredEnvironment("TAG"),
  });
  appendFileSync(requiredEnvironment("GITHUB_OUTPUT"), `commit=${result.commit}\nversion=${result.version}\n`, "utf8");
}

async function prepareCommand() {
  const gate = JSON.parse(readFileSync(requiredEnvironment("PACK_GATE_PATH"), "utf8"));
  const destination = resolve(requiredEnvironment("RELEASE_TARBALL_DIR"));
  const version = requiredEnvironment("RELEASE_VERSION");
  mkdirSync(destination, { recursive: true });

  const packs = [];
  for (const item of PACKAGES) {
    const manifest = JSON.parse(readFileSync(join(item.workspace, "package.json"), "utf8"));
    invariant(manifest.name === item.name, `${item.workspace}/package.json has an unexpected package name`);
    invariant(manifest.version === version, `${item.name} has version ${manifest.version}; expected ${version}`);
    const output = execFileSync(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--workspace", item.name, "--pack-destination", destination, "--loglevel=error"],
      { encoding: "utf8", env: { ...process.env, NO_UPDATE_NOTIFIER: "1" } },
    );
    const records = JSON.parse(output);
    invariant(Array.isArray(records) && records.length === 1, `npm pack returned an unexpected result for ${item.name}`);
    const record = records[0];
    const path = join(destination, record.filename);
    packs.push({
      name: record.name,
      version: record.version,
      filename: record.filename,
      integrity: record.integrity,
      path,
      bytes: readFileSync(path),
    });
  }

  const artifacts = await validatePreparedArtifacts({ gate, packs, version });
  writeFileSync(requiredEnvironment("RELEASE_PLAN_PATH"), `${JSON.stringify({ version, artifacts }, null, 2)}\n`, "utf8");
}

function npmView(name, version) {
  const result = spawnSync("npm", ["view", `${name}@${version}`, "dist", "--json", "--loglevel=error"], {
    encoding: "utf8",
    env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
  });
  if (result.status === 0) return JSON.parse(result.stdout);
  if (/E404|404 Not Found|is not in this registry/iu.test(result.stderr)) return null;
  throw new Error(`npm view failed for ${name}@${version}: ${result.stderr.trim() || `exit ${result.status}`}`);
}

async function publishCommand() {
  const plan = JSON.parse(readFileSync(requiredEnvironment("RELEASE_PLAN_PATH"), "utf8"));
  invariant(plan.version === requiredEnvironment("RELEASE_VERSION"), "Release plan version does not match the verified tag");
  await publishResumably({
    artifacts: plan.artifacts,
    lookup: npmView,
    publish: async (path) => {
      execFileSync("npm", ["publish", path, "--access", "public", "--provenance"], {
        stdio: "inherit",
        env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
      });
    },
    sleep: () => new Promise((resolveSleep) => setTimeout(resolveSleep, 5_000)),
  });
}

async function main() {
  const command = process.argv[2];
  if (command === "verify-tag") return verifyTagCommand();
  if (command === "prepare") return prepareCommand();
  if (command === "publish") return publishCommand();
  throw new Error("Usage: release.mjs <verify-tag|prepare|publish>");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
