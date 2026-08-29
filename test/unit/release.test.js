import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { publishReleaseTransaction } from "../../src/release.js";

describe("release publication transaction", () => {
  it("creates a draft, uploads assets, and publishes", async () => {
    const calls = [];
    const github = {
      createDraftRelease: async () => {
        calls.push("create");
        return { id: 42, draft: true };
      },
      uploadAsset: async (_id, asset) => calls.push(`upload:${asset.name}`),
      publishRelease: async () => {
        calls.push("publish");
        return {
          id: 42,
          draft: false,
          html_url: "https://example.test/release",
        };
      },
    };
    const release = await publishReleaseTransaction(github, {
      assets: [{ name: "one.zip" }, { name: "two.zip" }],
    });
    assert.deepEqual(calls, [
      "create",
      "upload:one.zip",
      "upload:two.zip",
      "publish",
    ]);
    assert.equal(release.draft, false);
  });

  it("deletes only the draft created by the current run", async () => {
    const calls = [];
    const github = {
      createDraftRelease: async () => ({ id: 42, draft: true }),
      uploadAsset: async () => {
        throw new Error("upload failed");
      },
      getRelease: async () => ({ id: 42, draft: true }),
      deleteRelease: async () => calls.push("delete"),
    };
    await assert.rejects(
      publishReleaseTransaction(github, { assets: [{ name: "one.zip" }] }),
      /upload failed/,
    );
    assert.deepEqual(calls, ["delete"]);
  });

  it("preserves a release that became published before an ambiguous failure", async () => {
    const calls = [];
    const github = {
      createDraftRelease: async () => ({ id: 42, draft: true }),
      uploadAsset: async () => {},
      publishRelease: async () => {
        throw new Error("connection closed");
      },
      getRelease: async () => ({ id: 42, draft: false }),
      deleteRelease: async () => calls.push("delete"),
    };
    await assert.rejects(
      publishReleaseTransaction(github, { assets: [] }),
      /connection closed/,
    );
    assert.deepEqual(calls, []);
  });
});
