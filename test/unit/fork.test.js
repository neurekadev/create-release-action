import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  analyzeForkHistory,
  resolveSoftFork,
  validateReleaseTransition,
} from "../../src/fork.js";
import { parseSemVer } from "../../src/semver.js";

function release(
  tag_name,
  body = "Upstream: [3.2.0 release notes](https://example.test/3.2.0)",
) {
  return { tag_name, body };
}

function history(...releases) {
  return analyzeForkHistory(releases);
}

function softReleases(core = "3.2.0", revision = 4) {
  return Array.from({ length: revision }, (_unused, index) =>
    release(`${core}+revision.${revision - index}`),
  );
}

function softHistory(core = "3.2.0", revision = 4) {
  return history(...softReleases(core, revision));
}

describe("fork releases", () => {
  it("requires contiguous same-core revisions", () => {
    const previous = softHistory();
    assert.equal(
      validateReleaseTransition(parseSemVer("3.2.0+revision.5"), previous),
      "soft",
    );
    assert.throws(
      () =>
        validateReleaseTransition(parseSemVer("3.2.0+revision.6"), previous),
      /must be 3.2.0\+revision.5/,
    );
  });

  it("requires revision one for an upstream reset and prevents rollback", () => {
    const previous = softHistory();
    validateReleaseTransition(parseSemVer("3.3.0+revision.1"), previous);
    assert.throws(
      () =>
        validateReleaseTransition(parseSemVer("3.3.0+revision.2"), previous),
      /reset/,
    );
    assert.throws(
      () =>
        validateReleaseTransition(parseSemVer("3.1.9+revision.1"), previous),
      /rolls back/,
    );
  });

  it("allows normal releases without requiring revision tags", () => {
    assert.equal(
      validateReleaseTransition(parseSemVer("3.2.1"), history()),
      "standard",
    );
  });

  it("requires the next stable major when a soft fork becomes hard", () => {
    const soft = softHistory();
    assert.equal(validateReleaseTransition(parseSemVer("4.0.0"), soft), "hard");
    assert.throws(
      () => validateReleaseTransition(parseSemVer("3.3.0"), soft),
      /next stable major 4.0.0/,
    );
    assert.throws(
      () => validateReleaseTransition(parseSemVer("4.0.0-rc.1"), soft),
      /next stable major 4.0.0/,
    );
  });

  it("keeps hard forks on normal Semantic Versions", () => {
    const hard = history(release("4.0.0"), ...softReleases());
    assert.equal(hard.mode, "hard");
    assert.equal(validateReleaseTransition(parseSemVer("4.0.1"), hard), "hard");
    assert.throws(
      () => validateReleaseTransition(parseSemVer("4.1.0+revision.1"), hard),
      /cannot return/,
    );
  });

  it("rejects revision history that returns from a hard fork", () => {
    assert.throws(
      () =>
        history(
          release("4.1.0+revision.1"),
          release("4.0.0"),
          ...softReleases(),
        ),
      /cannot return/,
    );
  });

  it("reuses the canonical upstream URL on same-core revisions", async () => {
    const previous = softHistory().previousRevision;
    const fork = await resolveSoftFork({
      github: {},
      repository: { fork: true },
      version: parseSemVer("3.2.0+revision.5"),
      previousRevision: previous,
      upstreamRepository: "auto",
      upstreamTag: "auto",
    });
    assert.equal(
      fork.line,
      "Upstream: [3.2.0 release notes](https://example.test/3.2.0)",
    );
  });

  it("resolves a new core from the GitHub fork parent", async () => {
    const requested = [];
    const fork = await resolveSoftFork({
      github: {
        findPublishedReleaseByTag: async (owner, repo, tag) => {
          requested.push([owner, repo, tag]);
          return tag === "v4.0.0"
            ? { html_url: "https://github.test/upstream/releases/v4.0.0" }
            : null;
        },
      },
      repository: { fork: true, parent: { full_name: "owner/upstream" } },
      version: parseSemVer("4.0.0+revision.1"),
      previousRevision: softHistory().previousRevision,
      upstreamRepository: "auto",
      upstreamTag: "auto",
    });
    assert.deepEqual(requested, [
      ["owner", "upstream", "4.0.0"],
      ["owner", "upstream", "v4.0.0"],
    ]);
    assert.equal(
      fork.upstreamUrl,
      "https://github.test/upstream/releases/v4.0.0",
    );
  });
});
