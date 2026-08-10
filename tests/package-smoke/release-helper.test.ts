import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

const helperUrl = new URL("../../.github/scripts/release.mjs", import.meta.url);

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

describe("trusted release helper", () => {
  it("accepts only a verified annotated exact SemVer tag bound to event SHA and HEAD", async () => {
    const { verifyTagIdentity } = await helper();
    const fetchJson = vi
      .fn()
      .mockResolvedValueOnce({ object: { type: "tag", sha: "tag-object" } })
      .mockResolvedValueOnce(githubTag());
    await expect(
      verifyTagIdentity({
        eventSha: "abc123",
        fetchJson,
        gitHead: "abc123",
        repository: "owner/repo",
        tag: "v1.2.3",
      }),
    ).resolves.toEqual({ commit: "abc123", version: "1.2.3" });
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
        eventSha: "abc123",
        fetchJson,
        gitHead: "abc123",
        repository: "owner/repo",
        tag: "v1.2.3",
      }),
    ).rejects.toThrow();
  });

  it("requires exact tag syntax and event SHA equal to checked-out HEAD", async () => {
    const { verifyTagIdentity } = await helper();
    const options = {
      eventSha: "abc123",
      fetchJson: vi.fn(),
      gitHead: "abc123",
      repository: "owner/repo",
      tag: "v1.2.3-beta.1",
    };
    await expect(verifyTagIdentity(options)).rejects.toThrow(/vX\.Y\.Z/u);
    await expect(
      verifyTagIdentity({ ...options, tag: "v01.2.3" }),
    ).rejects.toThrow(/vX\.Y\.Z/u);
    await expect(
      verifyTagIdentity({ ...options, tag: "v1.2.3", gitHead: "different" }),
    ).rejects.toThrow(/HEAD/u);
    expect(options.fetchJson).not.toHaveBeenCalled();
  });

  it("prepares all three exact verified tarballs in dependency order", async () => {
    const { validatePreparedArtifacts } = await helper();
    const entries = [
      ["@402v/html-kit-core", "402v-html-kit-core-1.2.3.tgz", Buffer.from("core")],
      ["@402v/theme-402v", "402v-theme-402v-1.2.3.tgz", Buffer.from("theme")],
      ["@402v/html-kit-cli", "402v-html-kit-cli-1.2.3.tgz", Buffer.from("cli")],
    ] as const;
    const gate = {
      ok: true,
      packages: entries.map(([name, filename, bytes]) => ({
        name,
        filename,
        integrity: integrity(bytes),
      })),
    };
    const packs = entries.map(([name, filename, bytes]) => ({
      name,
      version: "1.2.3",
      filename,
      integrity: integrity(bytes),
      path: `/tmp/${filename}`,
      bytes,
    }));
    await expect(validatePreparedArtifacts({ gate, packs, version: "1.2.3" })).resolves.toEqual(
      entries.map(([name, filename, bytes]) => ({
        name,
        version: "1.2.3",
        filename,
        integrity: integrity(bytes),
        path: `/tmp/${filename}`,
      })),
    );
  });

  it("rejects any pack-gate, npm-pack, or byte-integrity mismatch before publishing", async () => {
    const { validatePreparedArtifacts } = await helper();
    const bytes = Buffer.from("core");
    await expect(
      validatePreparedArtifacts({
        version: "1.2.3",
        gate: {
          ok: true,
          packages: [{ name: "@402v/html-kit-core", filename: "wrong.tgz", integrity: integrity(bytes) }],
        },
        packs: [{
          name: "@402v/html-kit-core",
          version: "1.2.3",
          filename: "core.tgz",
          integrity: integrity(bytes),
          path: "/tmp/core.tgz",
          bytes,
        }],
      }),
    ).rejects.toThrow();
  });

  it("skips matching published packages and publishes absent exact tarballs in order", async () => {
    const { publishResumably } = await helper();
    const artifacts = [
      { name: "@402v/html-kit-core", version: "1.2.3", path: "/tmp/core.tgz", integrity: "sha512-core" },
      { name: "@402v/theme-402v", version: "1.2.3", path: "/tmp/theme.tgz", integrity: "sha512-theme" },
      { name: "@402v/html-kit-cli", version: "1.2.3", path: "/tmp/cli.tgz", integrity: "sha512-cli" },
    ];
    const seen = new Map<string, number>();
    const lookup = vi.fn(async (name: string) => {
      const count = seen.get(name) ?? 0;
      seen.set(name, count + 1);
      if (name === "@402v/html-kit-core") {
        return { integrity: "sha512-core", attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } };
      }
      if (count === 0) return null;
      const artifact = artifacts.find((candidate) => candidate.name === name)!;
      return { integrity: artifact.integrity, attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } };
    });
    const publish = vi.fn(async () => undefined);
    await expect(
      publishResumably({ artifacts, lookup, publish, sleep: vi.fn(), maxPolls: 3 }),
    ).resolves.toBeUndefined();
    expect(publish.mock.calls).toEqual([
      ["/tmp/theme.tgz"],
      ["/tmp/cli.tgz"],
    ]);
  });

  it.each([
    ["mismatched integrity", { integrity: "sha512-wrong", attestations: { provenance: { predicateType: "https://slsa.dev/provenance/v1" } } }],
    ["missing provenance", { integrity: "sha512-core" }],
  ])("fails closed for an existing package with %s", async (_label, dist) => {
    const { publishResumably } = await helper();
    const publish = vi.fn();
    await expect(
      publishResumably({
        artifacts: [{ name: "@402v/html-kit-core", version: "1.2.3", path: "/tmp/core.tgz", integrity: "sha512-core" }],
        lookup: vi.fn().mockResolvedValue(dist),
        publish,
        sleep: vi.fn(),
        maxPolls: 2,
      }),
    ).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it("bounds post-publish polling and fails when provenance never appears", async () => {
    const { publishResumably } = await helper();
    const lookup = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValue({ integrity: "sha512-core" });
    await expect(
      publishResumably({
        artifacts: [{ name: "@402v/html-kit-core", version: "1.2.3", path: "/tmp/core.tgz", integrity: "sha512-core" }],
        lookup,
        publish: vi.fn().mockResolvedValue(undefined),
        sleep: vi.fn().mockResolvedValue(undefined),
        maxPolls: 2,
      }),
    ).rejects.toThrow(/provenance/u);
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});
