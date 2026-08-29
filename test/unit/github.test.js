import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { selectBaseline } from "../../src/github.js";

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
});
