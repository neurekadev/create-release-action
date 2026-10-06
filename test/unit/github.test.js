import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubService, selectBaseline } from "../../src/github.js";

describe("published release baseline", () => {
  it("selects the newest published release reachable from the tag commit", async () => {
    const releases = [
      { tag_name: "2.0.0", draft: false, published_at: "2026-02-01T00:00:00Z" },
      { tag_name: "1.1.0", draft: false, published_at: "2026-01-01T00:00:00Z" },
      { tag_name: "3.0.0", draft: true, published_at: "2026-03-01T00:00:00Z" },
    ];
    const git = {
      hasCommit: async () => true,
      isAncestor: async (tag) => tag === "1.1.0",
    };
    const result = await selectBaseline(releases, "2.1.0", "head", git);
    assert.equal(result.baseline.tag_name, "1.1.0");
    assert.deepEqual(
      result.reachable.map((release) => release.tag_name),
      ["1.1.0"],
    );
  });

  it("compares stable releases with the previous stable release", async () => {
    const releases = [
      {
        tag_name: "nightly",
        draft: false,
        published_at: "2026-04-01T00:00:00Z",
      },
      {
        tag_name: "4.0.0-rc.1",
        draft: false,
        prerelease: true,
        published_at: "2026-03-01T00:00:00Z",
      },
      {
        tag_name: "3.2.0",
        draft: false,
        prerelease: true,
        published_at: "2026-02-15T00:00:00Z",
      },
      { tag_name: "3.1.0", draft: false, published_at: "2026-02-01T00:00:00Z" },
    ];
    const git = { hasCommit: async () => true, isAncestor: async () => true };

    const stable = await selectBaseline(releases, "4.0.0", "head", git);
    assert.equal(stable.baseline.tag_name, "3.1.0");
    assert.equal(stable.reachable.length, 4);

    const prerelease = await selectBaseline(
      releases,
      "4.0.0-rc.2",
      "head",
      git,
      { stable: false },
    );
    assert.equal(prerelease.baseline.tag_name, "4.0.0-rc.1");

    const migrated = await selectBaseline(
      [
        {
          tag_name: "v3.1.0",
          draft: false,
          published_at: "2026-01-01T00:00:00Z",
        },
      ],
      "3.2.0",
      "head",
      git,
    );
    assert.equal(migrated.baseline.tag_name, "v3.1.0");

    const retagged = await selectBaseline(
      [
        {
          tag_name: "v3.2.0",
          draft: false,
          published_at: "2026-02-01T00:00:00Z",
        },
        {
          tag_name: "v3.1.0",
          draft: false,
          published_at: "2026-01-01T00:00:00Z",
        },
      ],
      "3.2.0",
      "head",
      git,
    );
    assert.equal(retagged.baseline.tag_name, "v3.1.0");
  });

  it("updates only the body of an existing release", async () => {
    let parameters;
    const expected = {
      id: 42,
      tag_name: "2.0.0",
      name: "Custom release name",
      body: "Replacement notes",
      draft: false,
      prerelease: false,
      assets: [{ id: 7, name: "artifact.zip" }],
    };
    const service = new GitHubService(
      {
        rest: {
          repos: {
            updateRelease: async (received) => {
              parameters = received;
              return { data: expected };
            },
          },
        },
      },
      "octo-org",
      "example",
    );

    const release = await service.updateReleaseBody(42, "Replacement notes");
    assert.equal(release, expected);
    assert.deepEqual(parameters, {
      owner: "octo-org",
      repo: "example",
      release_id: 42,
      body: "Replacement notes",
    });
  });
});
