import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareCore, isPrerelease, parseSemVer } from "../../src/semver.js";

describe("Semantic Version tags", () => {
  it("accepts complete bare versions", () => {
    assert.deepEqual(parseSemVer("1.2.3"), {
      raw: "1.2.3",
      major: 1,
      minor: 2,
      patch: 3,
      core: "1.2.3",
      prerelease: null,
      build: null,
      forkRevision: null,
    });
    assert.equal(isPrerelease(parseSemVer("1.2.3-rc.1")), true);
  });

  it("rejects prefixes, incomplete tags, and invalid numeric identifiers", () => {
    for (const tag of ["v1.2.3", "1.2", "01.2.3", "1.2.3-01"]) {
      assert.throws(() => parseSemVer(tag), /Semantic Version/);
    }
  });

  it("recognizes only exact Neureka revisions", () => {
    assert.equal(parseSemVer("2.4.0+neureka.10").forkRevision, 10);
    for (const tag of [
      "2.4.0+neureka.0",
      "2.4.0+neureka.01",
      "2.4.0+neureka.1.extra",
      "2.4.0-rc.1+neureka.1",
    ]) {
      assert.throws(() => parseSemVer(tag), /Neureka versions/);
    }
  });

  it("compares upstream cores numerically", () => {
    assert.equal(compareCore(parseSemVer("2.10.0"), parseSemVer("2.9.9")), 1);
    assert.equal(compareCore(parseSemVer("2.9.9"), parseSemVer("2.10.0")), -1);
    assert.equal(
      compareCore(parseSemVer("2.10.0"), parseSemVer("2.10.0+neureka.1")),
      0,
    );
  });
});
