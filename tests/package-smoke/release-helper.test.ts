import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const publicCertificateSource = {
  repository: "https://github.com/npm/package-json",
  workflow: ".github/workflows/release-integration.yml",
  ref: "refs/heads/main",
};
const githubOidcIssuer = "https://token.actions.githubusercontent.com";
const offlineTufFixtureTime = new Date("2026-08-10T00:00:00Z");

function offlineTufMetadata(): any {
  return JSON.parse(readFileSync(
    new URL("./fixtures/sigstore-tuf-metadata.json", import.meta.url),
    "utf8",
  ));
}

function realProvenanceBundle(): Record<string, unknown> {
  return JSON.parse(readFileSync(
    new URL("./fixtures/npmcli-package-json-7.0.4-provenance-bundle.json", import.meta.url),
    "utf8",
  ));
}

function createOfflineTufCache(): string {
  const root = mkdtempSync(join(tmpdir(), "402v-sigstore-tuf-test-"));
  const repository = join(root, "tuf-repo-cdn.sigstore.dev");
  mkdirSync(join(repository, "targets"), { recursive: true });
  const metadata = offlineTufMetadata();
  for (const name of ["root", "timestamp", "snapshot", "targets"]) {
    writeFileSync(join(repository, `${name}.json`), JSON.stringify(metadata[name]), "utf8");
  }
  const trustedRoot = readFileSync(new URL("./fixtures/sigstore-trusted-root.json", import.meta.url));
  const trustedRootHash = metadata.targets.signed.targets["trusted_root.json"].hashes.sha256;
  for (const targetName of ["trusted_root.json", `${trustedRootHash}.trusted_root.json`]) {
    writeFileSync(join(repository, "targets", targetName), trustedRoot);
  }
  return root;
}

describe("trusted release helper", () => {
  it("pins Sigstore for provenance while starting verify-tag without installed development dependencies", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
    expect(manifest.devDependencies.sigstore).toBe("4.1.1");
    const installed = JSON.parse(readFileSync(new URL("../../node_modules/sigstore/package.json", import.meta.url), "utf8"));
    expect(installed.version).toBe("4.1.1");
    expect(installed.license).toBe("Apache-2.0");

    const root = mkdtempSync(join(tmpdir(), "402v-release-verify-tag-test-"));
    const script = join(root, "release.mjs");
    writeFileSync(script, readFileSync(helperUrl), "utf8");
    try {
      const result = spawnSync(process.execPath, [script, "verify-tag"], {
        encoding: "utf8",
        env: {},
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("EVENT_REF is required");
      expect(result.stderr).not.toContain("ERR_MODULE_NOT_FOUND");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("builds one escaped and anchored Fulcio identity URI from the verified source", async () => {
    const { certificateIdentityPolicy } = await helper();
    const policy = certificateIdentityPolicy(sourceIdentity());
    const expected = "https://github.com/owner/repo/.github/workflows/release.yml@refs/tags/v1.2.3";
    expect(policy.identityURI).toBe(expected);
    expect(policy.identityPattern).toBeInstanceOf(RegExp);
    expect(policy.identityPattern.test(expected)).toBe(true);
    expect(policy.identityPattern.test(`${expected}-attacker`)).toBe(false);
    expect(policy.identityPattern.test(expected.replace("github.com", "githubXcom"))).toBe(false);
    expect(policy.issuer).toBe(githubOidcIssuer);
  });

  it("pins real offline Sigstore verification inside every TUF metadata validity window", () => {
    const metadata = offlineTufMetadata();
    for (const name of ["root", "timestamp", "snapshot", "targets"]) {
      expect(offlineTufFixtureTime.getTime()).toBeLessThan(Date.parse(metadata[name].signed.expires));
    }
  });

  it.each([
    ["expected SAN and issuer", publicCertificateSource, githubOidcIssuer, false],
    ["wrong workflow SAN", { ...publicCertificateSource, workflow: ".github/workflows/other.yml" }, githubOidcIssuer, true],
    ["wrong repository SAN", { ...publicCertificateSource, repository: "https://github.com/attacker/package-json" }, githubOidcIssuer, true],
    ["wrong issuer", publicCertificateSource, "https://issuer.example", true],
  ])("uses real sigstore verification for %s", async (_label, source, issuer, rejects) => {
    const { verifyBundleCertificate } = await helper();
    const tufCachePath = createOfflineTufCache();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(offlineTufFixtureTime);
      const verification = verifyBundleCertificate({
        bundle: realProvenanceBundle(),
        source,
        certificateIssuer: issuer,
        tufCachePath,
      });
      if (rejects) await expect(verification).rejects.toThrow();
      else await expect(verification).resolves.toBeUndefined();
    } finally {
      rmSync(tufCachePath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

  it("fails real sigstore verification when certificate material is missing", async () => {
    const { verifyBundleCertificate } = await helper();
    const bundle: any = structuredClone(realProvenanceBundle());
    delete bundle.verificationMaterial.certificate;
    const tufCachePath = createOfflineTufCache();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(offlineTufFixtureTime);
      await expect(verifyBundleCertificate({
        bundle,
        source: publicCertificateSource,
        tufCachePath,
      })).rejects.toThrow();
    } finally {
      rmSync(tufCachePath, { recursive: true, force: true });
      vi.useRealTimers();
    }
  });

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
    }).statement).toEqual(provenanceStatement(artifact));
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

  it.each([
    "ATTESTATION_NOT_AVAILABLE",
    "E404",
    "EAI_AGAIN",
    "ECONNRESET",
    "ETIMEDOUT",
    "TUF_DOWNLOAD_TARGET_ERROR",
    "TUF_REFRESH_METADATA_ERROR",
    "TUF_FIND_TARGET_ERROR",
  ])("classifies only explicit propagation error %s as retryable", async (code) => {
    const { isRetryableAttestationError } = await helper();
    expect(isRetryableAttestationError(Object.assign(new Error(code), { code }))).toBe(true);
  });

  it.each(["UNTRUSTED_SIGNER_ERROR", "SIGNATURE_ERROR", "TLOG_ERROR", "EATTESTATIONVERIFY"])(
    "classifies permanent identity/digest/schema/crypto error %s as non-retryable",
    async (code) => {
      const { isRetryableAttestationError } = await helper();
      expect(isRetryableAttestationError(Object.assign(new Error(code), { code }))).toBe(false);
    },
  );

  it("retries post-publish attestation propagation failures within the bounded poll", async () => {
    const { publishResumably } = await helper();
    const artifact = artifactFixture()[0];
    const verifyAttestation = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error("not propagated"), { code: "ATTESTATION_NOT_AVAILABLE" }))
      .mockRejectedValueOnce(Object.assign(new Error("tuf unavailable"), { code: "TUF_REFRESH_METADATA_ERROR" }))
      .mockResolvedValue(undefined);
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(publishResumably({
      artifacts: [artifact],
      source: sourceIdentity(),
      lookup: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(registryDist(artifact)),
      publish: vi.fn().mockResolvedValue(undefined),
      verifyAttestation,
      sleep,
      maxPolls: 3,
    })).resolves.toBeUndefined();
    expect(verifyAttestation).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("does not retry a post-publish identity or cryptographic mismatch", async () => {
    const { publishResumably } = await helper();
    const artifact = artifactFixture()[0];
    const verifyAttestation = vi.fn().mockRejectedValue(
      Object.assign(new Error("wrong signer"), { code: "UNTRUSTED_SIGNER_ERROR" }),
    );
    const sleep = vi.fn();
    await expect(publishResumably({
      artifacts: [artifact],
      source: sourceIdentity(),
      lookup: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(registryDist(artifact)),
      publish: vi.fn().mockResolvedValue(undefined),
      verifyAttestation,
      sleep,
      maxPolls: 3,
    })).rejects.toThrow(/wrong signer/u);
    expect(verifyAttestation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([
    ["duplicate verified entries", (audit: any) => {
      audit.verified.push(structuredClone(audit.verified[0]));
    }],
    ["duplicate provenance bundles", (audit: any) => {
      audit.verified[0].attestationBundles.push(structuredClone(audit.verified[0].attestationBundles[0]));
    }],
  ])("does not retry permanent %s", async (_label, mutateAudit) => {
    const { publishResumably, validateVerifiedAttestation } = await helper();
    const artifact = artifactFixture()[0];
    const audit = npmAuditResult(artifact);
    mutateAudit(audit);
    const verifyAttestation = vi.fn(async (item, source) => {
      validateVerifiedAttestation({ artifact: item, audit, source });
    });
    const sleep = vi.fn();
    await expect(publishResumably({
      artifacts: [artifact],
      source: sourceIdentity(),
      lookup: vi.fn().mockResolvedValueOnce(null).mockResolvedValue(registryDist(artifact)),
      publish: vi.fn().mockResolvedValue(undefined),
      verifyAttestation,
      sleep,
      maxPolls: 3,
    })).rejects.toThrow(/more than one/u);
    expect(verifyAttestation).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
