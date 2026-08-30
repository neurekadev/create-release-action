import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAction } from "../../src/run.js";

const DEFAULT_INPUTS = Object.freeze({
  "api-key": "model-token",
  "base-url": "https://api.example.test",
  files: "dist/*.zip",
  "github-token": "github-token",
  "max-chunk": "200000",
  model: "example-model",
  "reasoning-effort": "max",
  "release-notes-audience": "end-user",
  "request-options": "{}",
  timeout: "300",
  "upstream-repository": "auto",
  "upstream-tag": "auto",
});

function coreStub(inputs = {}) {
  const values = { ...DEFAULT_INPUTS, ...inputs };
  const outputs = new Map();
  const info = [];
  const secrets = [];
  return {
    getInput(name, options = {}) {
      const value = values[name] || "";
      if (options.required && !value) {
        throw new Error(`Input required and not supplied: ${name}`);
      }
      return value;
    },
    info(message) {
      info.push(message);
    },
    setOutput(name, value) {
      outputs.set(name, value);
    },
    setSecret(value) {
      secrets.push(value);
    },
    infoMessages: info,
    outputs,
    secrets,
  };
}

function publishedRelease(tag, id, overrides = {}) {
  return {
    id,
    tag_name: tag,
    name: `Release ${tag}`,
    body: `Original notes for ${tag}`,
    draft: false,
    prerelease: false,
    html_url: `https://github.test/releases/${tag}`,
    published_at: `2026-0${id}-01T00:00:00Z`,
    assets: [{ id: id * 10, name: "artifact.zip" }],
    ...overrides,
  };
}

function dispatchEnvironment() {
  return {
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_SHA: "workflow-sha",
    GITHUB_WORKSPACE: "/workspace",
  };
}

function pushEnvironment(tag = "2.0.0", sha = "target-sha") {
  return {
    GITHUB_EVENT_NAME: "push",
    GITHUB_REF_NAME: tag,
    GITHUB_REF_TYPE: "tag",
    GITHUB_SHA: sha,
    GITHUB_WORKSPACE: "/workspace",
  };
}

function gitStub(calls = []) {
  return {
    async resolveCommit(ref) {
      calls.push(["resolve", ref]);
      return "target-sha";
    },
    async hasCommit(ref) {
      calls.push(["has", ref]);
      return true;
    },
    async isAncestor(ref, target) {
      calls.push(["ancestor", ref, target]);
      return true;
    },
    async buildComparison(baseline, target) {
      calls.push(["compare", baseline, target]);
      return "release comparison";
    },
  };
}

describe("action orchestration", () => {
  it("regenerates a published release body after generation succeeds", async () => {
    const calls = [];
    const core = coreStub({
      "release-notes-audience": "technical",
      "release-tag": "2.0.0",
    });
    const target = publishedRelease("2.0.0", 2);
    const baseline = publishedRelease("1.0.0", 1);
    const updated = { ...target, body: "### Changed\n- Clearer notes." };
    const model = { name: "model boundary" };
    const release = await runAction({
      core,
      env: dispatchEnvironment(),
      githubService: {
        async listReleases() {
          calls.push(["list"]);
          return [target, baseline];
        },
        async updateReleaseBody(id, body) {
          calls.push(["update", id, body]);
          return updated;
        },
      },
      gitRepository: gitStub(calls),
      createModelClient(options) {
        calls.push(["model", options]);
        return model;
      },
      async generateNotes(receivedModel, comparison, options) {
        calls.push(["generate", receivedModel, comparison, options]);
        return {
          hasReleaseChanges: true,
          notes: "### Changed\n- Clearer notes.",
        };
      },
      async resolveReleaseAssets() {
        throw new Error("assets must not be resolved during regeneration");
      },
      async publishRelease() {
        throw new Error("regeneration must not publish a new release");
      },
    });

    assert.equal(release, updated);
    assert.equal(target.body, "Original notes for 2.0.0");
    assert.deepEqual(
      calls.find((call) => call[0] === "resolve"),
      ["resolve", "refs/tags/2.0.0"],
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "compare"),
      ["compare", "1.0.0", "target-sha"],
    );
    const generation = calls.find((call) => call[0] === "generate");
    assert.equal(generation[1], model);
    assert.equal(generation[2], "release comparison");
    assert.equal(generation[3].version.raw, "2.0.0");
    assert.equal(generation[3].baselineTag, "1.0.0");
    assert.equal(generation[3].audience, "technical");
    assert.equal(generation[3].maxChunk, 200000);
    assert.ok(
      calls.findIndex((call) => call[0] === "generate") <
        calls.findIndex((call) => call[0] === "update"),
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "update"),
      ["update", 2, "### Changed\n- Clearer notes."],
    );
    assert.equal(core.outputs.get("release-id"), "2");
    assert.equal(
      core.outputs.get("release-url"),
      "https://github.test/releases/2.0.0",
    );
    assert.equal(
      core.outputs.get("release-notes"),
      "### Changed\n- Clearer notes.",
    );
    assert.equal(core.outputs.get("baseline-tag"), "1.0.0");
    assert.deepEqual(core.secrets, ["github-token", "model-token"]);
  });

  it("leaves the published release unchanged when generation fails", async () => {
    for (const [name, generateNotes, pattern] of [
      [
        "request failure",
        async () => {
          throw new Error("model unavailable");
        },
        /model unavailable/,
      ],
      [
        "no qualifying changes",
        async () => ({ hasReleaseChanges: false, notes: "" }),
        /release 2\.0\.0 was left unchanged/,
      ],
    ]) {
      let updated = false;
      const target = publishedRelease("2.0.0", 2);
      await assert.rejects(
        runAction({
          core: coreStub({ "release-tag": "2.0.0" }),
          env: dispatchEnvironment(),
          githubService: {
            listReleases: async () => [target],
            updateReleaseBody: async () => {
              updated = true;
            },
          },
          gitRepository: gitStub(),
          createModelClient: () => ({}),
          generateNotes,
        }),
        pattern,
        name,
      );
      assert.equal(updated, false, name);
      assert.equal(target.body, "Original notes for 2.0.0", name);
    }
  });

  it("rejects missing, unpublished, and ambiguous dispatch targets", async () => {
    await assert.rejects(
      runAction({
        core: coreStub({ "release-tag": "" }),
        env: dispatchEnvironment(),
      }),
      /release-tag is required/,
    );
    await assert.rejects(
      runAction({
        core: coreStub({ "release-tag": "v2.0.0" }),
        env: dispatchEnvironment(),
      }),
      /complete bare Semantic Version/,
    );

    for (const [releases, pattern] of [
      [
        [publishedRelease("2.0.0", 2, { draft: true })],
        /No published release exists/,
      ],
      [
        [publishedRelease("2.0.0", 2), publishedRelease("2.0.0", 3)],
        /resolves ambiguously to 2 releases/,
      ],
    ]) {
      let generated = false;
      await assert.rejects(
        runAction({
          core: coreStub({ "release-tag": "2.0.0" }),
          env: dispatchEnvironment(),
          githubService: { listReleases: async () => releases },
          generateNotes: async () => {
            generated = true;
          },
        }),
        pattern,
      );
      assert.equal(generated, false);
    }
  });

  it("fails clearly when the dispatched tag is absent from local history", async () => {
    let updated = false;
    await assert.rejects(
      runAction({
        core: coreStub({ "release-tag": "2.0.0" }),
        env: dispatchEnvironment(),
        githubService: {
          listReleases: async () => [publishedRelease("2.0.0", 2)],
          updateReleaseBody: async () => {
            updated = true;
          },
        },
        gitRepository: {
          resolveCommit: async () => {
            throw new Error("unknown revision");
          },
        },
      }),
      /does not resolve to a commit in the checked-out repository/,
    );
    assert.equal(updated, false);
  });

  it("keeps an existing tag-push release idempotent", async () => {
    const core = coreStub({ "release-tag": "9.9.9" });
    const existing = publishedRelease("2.0.0", 2);
    const result = await runAction({
      core,
      env: pushEnvironment(),
      githubService: { listReleases: async () => [existing] },
      gitRepository: {
        resolveCommit: async () => {
          throw new Error("existing tag pushes must remain a no-op");
        },
      },
    });

    assert.equal(result, existing);
    assert.equal(core.outputs.get("release-notes"), existing.body);
    assert.equal(core.outputs.get("baseline-tag"), "");
    assert.match(core.infoMessages[0], /left unchanged/);
  });

  it("keeps new tag-push publication behavior unchanged", async () => {
    const calls = [];
    const core = coreStub();
    const baseline = publishedRelease("1.0.0", 1);
    const created = publishedRelease("2.0.0", 2, {
      body: "### Added\n- New behavior.",
    });
    const result = await runAction({
      core,
      env: pushEnvironment(),
      githubService: { listReleases: async () => [baseline] },
      gitRepository: gitStub(calls),
      createModelClient: () => ({}),
      generateNotes: async () => ({
        hasReleaseChanges: true,
        notes: "### Added\n- New behavior.",
      }),
      resolveReleaseAssets: async (files) => {
        calls.push(["assets", files]);
        return [{ name: "artifact.zip" }];
      },
      publishRelease: async (_github, parameters) => {
        calls.push(["publish", parameters]);
        return created;
      },
    });

    assert.equal(result, created);
    assert.deepEqual(
      calls.find((call) => call[0] === "resolve"),
      ["resolve", "2.0.0"],
    );
    assert.deepEqual(
      calls.find((call) => call[0] === "assets"),
      ["assets", "dist/*.zip"],
    );
    assert.deepEqual(calls.find((call) => call[0] === "publish")[1], {
      tag: "2.0.0",
      notes: "### Added\n- New behavior.",
      prerelease: false,
      assets: [{ name: "artifact.zip" }],
      makeLatest: "legacy",
    });
  });
});
