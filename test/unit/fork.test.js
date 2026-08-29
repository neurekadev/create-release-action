import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  findPreviousFork,
  resolveFork,
  validateForkTransition,
} from "../../src/fork.js";
import { parseSemVer } from "../../src/semver.js";

function previous(
  tag = "3.2.0+neureka.4",
  body = "Upstream: [3.2.0 release notes](https://example.test/3.2.0)",
) {
  return findPreviousFork([{ tag_name: tag, body }]);
}

describe("Neureka fork releases", () => {
  it("requires contiguous same-core revisions", () => {
    validateForkTransition(parseSemVer("3.2.0+neureka.5"), previous(), true);
    assert.throws(
      () =>
        validateForkTransition(
          parseSemVer("3.2.0+neureka.6"),
          previous(),
          true,
        ),
      /must be 3.2.0\+neureka.5/,
    );
  });

  it("requires revision one for an upstream reset and prevents rollback", () => {
    validateForkTransition(parseSemVer("3.3.0+neureka.1"), previous(), true);
    assert.throws(
      () =>
        validateForkTransition(
          parseSemVer("3.3.0+neureka.2"),
          previous(),
          true,
        ),
      /reset/,
    );
    assert.throws(
      () =>
        validateForkTransition(
          parseSemVer("3.1.9+neureka.1"),
          previous(),
          true,
        ),
      /rolls back/,
    );
  });

  it("does not allow a fork repository to drop the convention", () => {
    assert.throws(
      () => validateForkTransition(parseSemVer("3.2.1"), previous(), true),
      /requires an exact stable/,
    );
    assert.throws(
      () => validateForkTransition(parseSemVer("1.0.0"), null, true),
      /requires an exact stable/,
    );
  });

  it("reuses the canonical upstream URL on same-core revisions", async () => {
    const fork = await resolveFork({
      github: {},
      repository: { fork: true },
      version: parseSemVer("3.2.0+neureka.5"),
      previousFork: previous(),
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
    const fork = await resolveFork({
      github: {
        findPublishedReleaseByTag: async (owner, repo, tag) => {
          requested.push([owner, repo, tag]);
          return tag === "v4.0.0"
            ? { html_url: "https://github.test/upstream/releases/v4.0.0" }
            : null;
        },
      },
      repository: { fork: true, parent: { full_name: "owner/upstream" } },
      version: parseSemVer("4.0.0+neureka.1"),
      previousFork: previous(),
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
