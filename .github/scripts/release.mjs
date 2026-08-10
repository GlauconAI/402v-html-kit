import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const SEMVER_NUMBER = "(?:0|[1-9][0-9]*)";
const EXACT_TAG = new RegExp(`^v(${SEMVER_NUMBER}\\.${SEMVER_NUMBER}\\.${SEMVER_NUMBER})$`, "u");
const PROVENANCE_PREDICATE = "https://slsa.dev/provenance/v1";
const INTOTO_STATEMENT = "https://in-toto.io/Statement/v1";
const GITHUB_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
const RELEASE_WORKFLOW = ".github/workflows/release.yml";
const PACKAGES = [
  { name: "@402v/html-kit-core", workspace: "packages/core" },
  { name: "@402v/theme-402v", workspace: "packages/theme-402v" },
  { name: "@402v/html-kit-cli", workspace: "packages/cli" },
];

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

export async function verifyTagIdentity({ eventRef, eventSha, fetchJson, gitHead, repository, serverUrl, tag }) {
  const match = EXACT_TAG.exec(tag ?? "");
  invariant(match, `Release tag must be exact vX.Y.Z: ${tag ?? "<missing>"}`);
  invariant(eventRef === `refs/tags/${tag}`, "Release event ref must exactly match the pushed tag");
  invariant(eventSha && gitHead && eventSha === gitHead, "Checked-out HEAD must equal the release event SHA");
  invariant(repository, "GitHub repository is required");
  invariant(serverUrl, "GitHub server URL is required");

  const api = `https://api.github.com/repos/${repository}`;
  const ref = await fetchJson(`${api}/git/ref/tags/${encodeURIComponent(tag)}`);
  invariant(ref?.object?.type === "tag", "Release tag must be annotated, not lightweight");
  invariant(typeof ref.object.sha === "string", "Annotated tag object SHA is missing");

  const tagObject = await fetchJson(`${api}/git/tags/${ref.object.sha}`);
  invariant(tagObject?.tag === tag, "Annotated tag name does not match the pushed ref");
  invariant(tagObject?.verification?.verified === true, `GitHub did not verify the tag signature: ${tagObject?.verification?.reason ?? "unknown"}`);
  invariant(tagObject?.object?.type === "commit", "Annotated release tag must target a commit");
  invariant(tagObject.object.sha === eventSha && tagObject.object.sha === gitHead, "Annotated tag target must equal the release event SHA and checked-out HEAD");

  return {
    commit: gitHead,
    version: match[1],
    repository: `${serverUrl.replace(/\/$/u, "")}/${repository}`,
    workflow: RELEASE_WORKFLOW,
    ref: eventRef,
    tag,
  };
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

function packagePurl(name, version) {
  const encodedName = name.startsWith("@")
    ? `${encodeURIComponent(name.split("/", 1)[0])}/${name.slice(name.indexOf("/") + 1)}`
    : encodeURIComponent(name);
  return `pkg:npm/${encodedName}@${version}`;
}

function sha512Hex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity ?? "");
  invariant(match, "Artifact integrity must be a SHA-512 SRI value");
  const digest = Buffer.from(match[1], "base64");
  invariant(digest.length === 64 && digest.toString("base64") === match[1], "Artifact integrity must contain one canonical SHA-512 digest");
  return digest.toString("hex");
}

function validateSourceIdentity(source) {
  for (const field of ["repository", "workflow", "ref", "tag", "commit"]) {
    invariant(typeof source?.[field] === "string" && source[field] !== "", `Release source ${field} is required`);
  }
  invariant(source.workflow === RELEASE_WORKFLOW, `Release source workflow must be ${RELEASE_WORKFLOW}`);
  invariant(source.ref === `refs/tags/${source.tag}`, "Release source ref must exactly match its tag");
  invariant(EXACT_TAG.test(source.tag), "Release source tag must be exact vX.Y.Z");
  return source;
}

export function validateVerifiedAttestation({ artifact, audit, source }) {
  validateSourceIdentity(source);
  invariant(Array.isArray(audit?.invalid) && audit.invalid.length === 0, "npm reported an invalid package signature or attestation");
  invariant(Array.isArray(audit?.missing) && audit.missing.length === 0, "npm reported a missing package signature or attestation");
  invariant(Array.isArray(audit?.verified), "npm did not return verified attestations");
  const verified = audit.verified.filter((entry) => entry.name === artifact.name && entry.version === artifact.version);
  invariant(verified.length === 1, `npm did not return exactly one verified entry for ${artifact.name}@${artifact.version}`);
  const provenances = (verified[0].attestationBundles ?? [])
    .filter((entry) => entry.predicateType === PROVENANCE_PREDICATE);
  invariant(provenances.length === 1, `${artifact.name}@${artifact.version} must have exactly one npm-verified SLSA v1 provenance bundle`);

  const payload = provenances[0].bundle?.dsseEnvelope?.payload;
  invariant(typeof payload === "string" && payload !== "", "Verified provenance bundle has no DSSE payload");
  let statement;
  try {
    statement = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    throw new Error("Verified provenance bundle has an invalid DSSE statement");
  }
  invariant(statement?._type === INTOTO_STATEMENT, "Verified provenance uses an unsupported in-toto statement type");
  invariant(statement?.predicateType === PROVENANCE_PREDICATE, "Verified provenance uses an unsupported predicate type");
  invariant(Array.isArray(statement.subject) && statement.subject.length === 1, "Verified provenance must have exactly one subject");
  invariant(statement.subject[0]?.name === packagePurl(artifact.name, artifact.version), "Verified provenance subject package does not match the release artifact");
  invariant(statement.subject[0]?.digest?.sha512 === sha512Hex(artifact.integrity), "Verified provenance subject digest does not match the release tarball");

  const build = statement.predicate?.buildDefinition;
  invariant(build?.buildType === GITHUB_BUILD_TYPE, "Verified provenance build type is not the GitHub Actions workflow type");
  const workflow = build.externalParameters?.workflow;
  invariant(workflow?.repository === source.repository, "Verified provenance repository does not match the verified release source");
  invariant(workflow?.path === source.workflow, "Verified provenance workflow does not match the verified release source");
  invariant(workflow?.ref === source.ref, "Verified provenance workflow ref does not match the verified release tag");
  invariant(Array.isArray(build.resolvedDependencies) && build.resolvedDependencies.length === 1, "Verified provenance must have exactly one resolved source dependency");
  const dependency = build.resolvedDependencies[0];
  invariant(dependency?.uri === `git+${source.repository}@${source.ref}`, "Verified provenance source repository/ref does not match the verified release source");
  invariant(dependency?.digest?.gitCommit === source.commit, "Verified provenance commit does not match the verified release commit");
  return statement;
}

async function verifyNpmAttestation(artifact, source) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "402v-release-attestation-"));
  const npmEnvironment = { ...process.env, NO_UPDATE_NOTIFIER: "1" };
  try {
    writeFileSync(join(temporaryRoot, "package.json"), `${JSON.stringify({ private: true }, null, 2)}\n`, "utf8");
    execFileSync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", "--loglevel=error", `${artifact.name}@${artifact.version}`],
      { cwd: temporaryRoot, env: npmEnvironment, stdio: "ignore", timeout: 120_000 },
    );
    const output = execFileSync(
      "npm",
      ["audit", "signatures", "--json", "--include-attestations", "--omit=dev", "--ignore-scripts", "--loglevel=error"],
      { cwd: temporaryRoot, encoding: "utf8", env: npmEnvironment, maxBuffer: 16 * 1024 * 1024, timeout: 120_000 },
    );
    return validateVerifiedAttestation({ artifact, audit: JSON.parse(output), source });
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function publishResumably({ artifacts, source, lookup, publish, verifyAttestation, sleep, maxPolls = 12 }) {
  validateSourceIdentity(source);
  invariant(Number.isInteger(maxPolls) && maxPolls > 0, "maxPolls must be a positive integer");
  for (const artifact of artifacts) {
    invariant(artifact.version === source.tag.slice(1), `${artifact.name} version does not match the verified release tag`);
    const existing = await lookup(artifact.name, artifact.version);
    if (existing != null) {
      verifyRegistryDist(artifact, existing, { allowPending: false });
      await verifyAttestation(artifact, source);
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
    await verifyAttestation(artifact, source);
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
    eventRef: requiredEnvironment("EVENT_REF"),
    eventSha: requiredEnvironment("EVENT_SHA"),
    fetchJson: githubJson,
    gitHead: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    repository: requiredEnvironment("REPOSITORY"),
    serverUrl: requiredEnvironment("SERVER_URL"),
    tag: requiredEnvironment("TAG"),
  });
  appendFileSync(
    requiredEnvironment("GITHUB_OUTPUT"),
    ["commit", "version", "repository", "workflow", "ref", "tag"]
      .map((field) => `${field}=${result[field]}`)
      .join("\n") + "\n",
    "utf8",
  );
}

function releaseSourceFromEnvironment() {
  return validateSourceIdentity({
    repository: requiredEnvironment("RELEASE_SOURCE_REPOSITORY"),
    workflow: requiredEnvironment("RELEASE_SOURCE_WORKFLOW"),
    ref: requiredEnvironment("RELEASE_SOURCE_REF"),
    tag: requiredEnvironment("RELEASE_SOURCE_TAG"),
    commit: requiredEnvironment("RELEASE_SOURCE_COMMIT"),
  });
}

async function prepareCommand() {
  const gate = JSON.parse(readFileSync(requiredEnvironment("PACK_GATE_PATH"), "utf8"));
  const destination = resolve(requiredEnvironment("RELEASE_TARBALL_DIR"));
  const version = requiredEnvironment("RELEASE_VERSION");
  const source = releaseSourceFromEnvironment();
  invariant(source.tag === `v${version}`, "Verified release tag does not match the package version");
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
  writeFileSync(requiredEnvironment("RELEASE_PLAN_PATH"), `${JSON.stringify({ version, source, artifacts }, null, 2)}\n`, "utf8");
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
  const source = releaseSourceFromEnvironment();
  invariant(JSON.stringify(plan.source) === JSON.stringify(source), "Release plan source identity does not match the verified tag output");
  await publishResumably({
    artifacts: plan.artifacts,
    source,
    lookup: npmView,
    publish: async (path) => {
      execFileSync("npm", ["publish", path, "--access", "public", "--provenance"], {
        stdio: "inherit",
        env: { ...process.env, NO_UPDATE_NOTIFIER: "1" },
      });
    },
    verifyAttestation: verifyNpmAttestation,
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
