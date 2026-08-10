import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const helperUrl = new URL("../../.github/scripts/release.mjs", import.meta.url);
const provenanceType = "https://slsa.dev/provenance/v1";

async function helper(): Promise<any> {
  expect(existsSync(helperUrl), "release helper is missing").toBe(true);
  return import(`${helperUrl.href}?test=${Date.now()}-${Math.random()}`);
}

function integrity(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

function githubTag(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag: "v1.2.3",
    object: { type: "commit", sha: "abc123" },
    verification: { verified: true },
    ...overrides,
  };
}

function sourceIdentity(): Record<string, string> {
  return {
    repository: "https://github.com/owner/repo",
    workflow: ".github/workflows/release.yml",
    ref: "refs/tags/v1.2.3",
    tag: "v1.2.3",
    commit: "abc123",
  };
}

function preparedFixture() {
  const entries: Array<[string, string, Buffer]> = [
    ["@402v/html-kit-core", "402v-html-kit-core-1.2.3.tgz", Buffer.from("core")],
    ["@402v/theme-402v", "402v-theme-402v-1.2.3.tgz", Buffer.from("theme")],
    ["@402v/html-kit-cli", "402v-html-kit-cli-1.2.3.tgz", Buffer.from("cli")],
  ];
  return {
    gate: {
      ok: true,
      packages: entries.map(([name, filename, bytes]) => ({
        name,
        filename,
        integrity: integrity(bytes),
      })),
    },
    packs: entries.map(([name, filename, bytes]) => ({
      name,
      version: "1.2.3",
      filename,
      integrity: integrity(bytes),
      path: `/tmp/${filename}`,
      bytes,
    })),
  };
}

function artifactFixture() {
  return preparedFixture().packs.map(({ bytes: _bytes, filename, ...artifact }) => ({
    ...artifact,
    filename,
  }));
}

function registryDist(artifact: { integrity: string }): Record<string, unknown> {
  return {
    integrity: artifact.integrity,
    attestations: { provenance: { predicateType: provenanceType } },
  };
}

function provenanceStatement(
  artifact: { name: string; version: string; integrity: string },
  source = sourceIdentity(),
): Record<string, unknown> {
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{
      name: `pkg:npm/${encodeURIComponent(artifact.name.split("/", 1)[0])}/${artifact.name.split("/")[1]}@${artifact.version}`,
      digest: {
        sha512: Buffer.from(artifact.integrity.slice("sha512-".length), "base64").toString("hex"),
      },
    }],
    predicateType: provenanceType,
    predicate: {
      buildDefinition: {
        buildType: "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            repository: source.repository,
            path: source.workflow,
            ref: source.ref,
          },
        },
        resolvedDependencies: [{
          uri: `git+${source.repository}@${source.ref}`,
          digest: { gitCommit: source.commit },
        }],
      },
    },
  };
}

function npmAuditResult(
  artifact: { name: string; version: string; integrity: string },
  statement = provenanceStatement(artifact),
): Record<string, unknown> {
  return {
    invalid: [],
    missing: [],
    verified: [{
      name: artifact.name,
      version: artifact.version,
      attestationBundles: [{
        predicateType: provenanceType,
        bundle: {
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          },
        },
      }],
    }],
  };
}

describe("trusted release helper", () => {
  it("accepts only a verified annotated exact SemVer tag bound to event ref, SHA, and HEAD", async () => {
    const { verifyTagIdentity } = await helper();
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ object: { type: "tag", sha: "tag-object" } })
      .mockResolvedValueOnce(githubTag());
    await expect(
      verifyTagIdentity({
        eventRef: "refs/tags/v1.2.3",
        eventSha: "abc123",
        fetchJson,
        gitHead: "abc123",
        repository: "owner/repo",
        serverUrl: "https://github.com",
        tag: "v1.2.3",
      }),
    ).resolves.toEqual({
      commit: "abc123",
      version: "1.2.3",
      repository: "https://github.com/owner/repo",
      workflow: ".github/workflows/release.yml",
      ref: "refs/tags/v1.2.3",
      tag: "v1.2.3",
    });
    expect(fetchJson).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["lightweight tag", { ref: { object: { type: "commit", sha: "abc123" } } }],
    ["unverified signature", { tagObject: githubTag({ verification: { verified: false } }) }],
    ["non-commit target", { tagObject: githubTag({ object: { type: "tree", sha: "abc123" } }) }],
    ["different target", { tagObject: githubTag({ object: { type: "commit", sha: "other" } }) }],
  ])("rejects a %s", async (_label, override: any) => {
    const { verifyTagIdentity } = await helper();
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce(override.ref ?? { object: { type: "tag", sha: "tag-object" } })
      .mockResolvedValueOnce(override.tagObject ?? githubTag());
    await expect(
      verifyTagIdentity({
        eventRef: "refs/tags/v1.2.3",
        eventSha: "abc123",
        fetchJson,
        gitHead: "abc123",
        repository: "owner/repo",
        serverUrl: "https://github.com",
        tag: "v1.2.3",
      }),
    ).rejects.toThrow();
  });

  it("requires exact tag syntax, event tag ref, and event SHA equal to HEAD", async () => {
    const { verifyTagIdentity } = await helper();
    const options = {
      eventRef: "refs/tags/v1.2.3",
      eventSha: "abc123",
      fetchJson: vi.fn(),
      gitHead: "abc123",
      repository: "owner/repo",
      serverUrl: "https://github.com",
      tag: "v1.2.3-beta.1",
    };
    await expect(verifyTagIdentity(options)).rejects.toThrow(/vX\.Y\.Z/u);
    await expect(verifyTagIdentity({ ...options, tag: "v01.2.3" })).rejects.toThrow(/vX\.Y\.Z/u);
    await expect(
      verifyTagIdentity({ ...options, tag: "v1.2.3", eventRef: "refs/tags/v9.9.9" }),
    ).rejects.toThrow(/event ref/u);
    await expect(
      verifyTagIdentity({ ...options, tag: "v1.2.3", gitHead: "different" }),
    ).rejects.toThrow(/HEAD/u);
    expect(options.fetchJson).not.toHaveBeenCalled();
  });

  it("prepares all three exact verified tarballs in dependency order", async () => {
    const { validatePreparedArtifacts } = await helper();
    const fixture = preparedFixture();
    await expect(validatePreparedArtifacts({ ...fixture, version: "1.2.3" })).resolves.toEqual(
      artifactFixture(),
    );
  });

  it.each([
    ["filename", (fixture: ReturnType<typeof preparedFixture>) => { fixture.packs[0].filename = "wrong.tgz"; }, /filename/u],
    ["integrity", (fixture: ReturnType<typeof preparedFixture>) => { fixture.packs[0].integrity = integrity(Buffer.from("other")); }, /integrity differs/u],
    ["bytes", (fixture: ReturnType<typeof preparedFixture>) => { fixture.packs[0].bytes = Buffer.from("other"); }, /bytes/u],
    ["version", (fixture: ReturnType<typeof preparedFixture>) => { fixture.packs[0].version = "9.9.9"; }, /version/u],
  ])("rejects an independently mutated %s in a complete three-package fixture", async (_label, mutate, message) => {
    const { validatePreparedArtifacts } = await helper();
    const fixture = preparedFixture();
    mutate(fixture);
    await expect(validatePreparedArtifacts({ ...fixture, version: "1.2.3" })).rejects.toThrow(message);
  });

  it.each([
    ["repository", (statement: any) => { statement.predicate.buildDefinition.externalParameters.workflow.repository = "https://github.com/attacker/repo"; }, /repository/u],
    ["workflow", (statement: any) => { statement.predicate.buildDefinition.externalParameters.workflow.path = ".github/workflows/other.yml"; }, /workflow/u],
    ["ref/tag", (statement: any) => { statement.predicate.buildDefinition.externalParameters.workflow.ref = "refs/tags/v9.9.9"; }, /ref/u],
    ["commit", (statement: any) => { statement.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "other"; }, /commit/u],
    ["subject", (statement: any) => { statement.subject[0].digest.sha512 = "00".repeat(64); }, /subject/u],
  ])("fails closed when verified provenance has the wrong %s", async (_label, mutate, message) => {
    const { validateVerifiedAttestation } = await helper();
    const artifact = artifactFixture()[0];
    const statement: any = provenanceStatement(artifact);
    mutate(statement);
    expect(() => validateVerifiedAttestation({
      artifact,
      audit: npmAuditResult(artifact, statement),
      source: sourceIdentity(),
    })).toThrow(message);
  });

  it("accepts npm-verified Sigstore provenance bound to artifact and source identity", async () => {
    const { validateVerifiedAttestation } = await helper();
    const artifact = artifactFixture()[0];
    expect(validateVerifiedAttestation({
      artifact,
      audit: npmAuditResult(artifact),
      source: sourceIdentity(),
    })).toEqual(provenanceStatement(artifact));
  });

  it("rejects npm audit results with invalid, missing, or absent verified attestations", async () => {
    const { validateVerifiedAttestation } = await helper();
    const artifact = artifactFixture()[0];
    for (const audit of [
      { ...npmAuditResult(artifact), invalid: [{ code: "EATTESTATIONVERIFY" }] },
      { ...npmAuditResult(artifact), missing: [{ name: artifact.name }] },
      { ...npmAuditResult(artifact), verified: [] },
    ]) {
      expect(() => validateVerifiedAttestation({ artifact, audit, source: sourceIdentity() })).toThrow();
    }
  });

  it("skips matching verified packages and publishes absent exact tarballs in order", async () => {
    const { publishResumably } = await helper();
    const artifacts = artifactFixture();
    const seen = new Map<string, number>();
    const lookup = vi.fn(async (name: string) => {
      const count = seen.get(name) ?? 0;
      seen.set(name, count + 1);
      if (name === "@402v/html-kit-core") return registryDist(artifacts[0]);
      if (count === 0) return null;
      return registryDist(artifacts.find((candidate) => candidate.name === name)!);
    });
    const publish = vi.fn(async () => undefined);
    const verifyAttestation = vi.fn(async (_artifact: any, _source: any) => undefined);
    await expect(
      publishResumably({
        artifacts,
        source: sourceIdentity(),
        lookup,
        publish,
        verifyAttestation,
        sleep: vi.fn(),
        maxPolls: 3,
      }),
    ).resolves.toBeUndefined();
    expect(publish.mock.calls).toEqual([
      ["/tmp/402v-theme-402v-1.2.3.tgz"],
      ["/tmp/402v-html-kit-cli-1.2.3.tgz"],
    ]);
    expect(verifyAttestation.mock.calls.map(([artifact]) => artifact.name)).toEqual(
      artifacts.map((artifact) => artifact.name),
    );
  });

  it.each([
    ["integrity", (dist: any) => { dist.integrity = "sha512-wrong"; }, /integrity/u],
    ["provenance", (dist: any) => { delete dist.attestations.provenance; }, /provenance/u],
  ])("fails closed for independently mutated registry %s with a complete fixture", async (_label, mutate, message) => {
    const { publishResumably } = await helper();
    const artifacts = artifactFixture();
    const dist: any = registryDist(artifacts[0]);
    mutate(dist);
    const publish = vi.fn();
    await expect(
      publishResumably({
        artifacts,
        source: sourceIdentity(),
        lookup: vi.fn().mockResolvedValue(dist),
        publish,
        verifyAttestation: vi.fn(),
        sleep: vi.fn(),
        maxPolls: 2,
      }),
    ).rejects.toThrow(message);
    expect(publish).not.toHaveBeenCalled();
  });

  it("bounds post-publish polling and fails when provenance never appears", async () => {
    const { publishResumably } = await helper();
    const artifacts = artifactFixture();
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ integrity: artifacts[0].integrity });
    await expect(
      publishResumably({
        artifacts,
        source: sourceIdentity(),
        lookup,
        publish: vi.fn().mockResolvedValue(undefined),
        verifyAttestation: vi.fn(),
        sleep: vi.fn().mockResolvedValue(undefined),
        maxPolls: 2,
      }),
    ).rejects.toThrow(/provenance/u);
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});
