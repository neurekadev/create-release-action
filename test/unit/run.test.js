import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runAction } from "../../src/run.js";

const DEFAULT_INPUTS = Object.freeze({
  "api-format": "openai",
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
  const warnings = [];
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
    warning(message) {
      warnings.push(message);
    },
    setOutput(name, value) {
      outputs.set(name, value);
    },
    setSecret(value) {
      secrets.push(value);
    },
    infoMessages: info,
    warningMessages: warnings,
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

  it("regenerates every published release oldest first when regenerate-all is true", async () => {
    const calls = [];
    const core = coreStub({ "regenerate-all": "true" });
    const releases = [
      publishedRelease("3.0.0", 4),
      publishedRelease("4.0.0", 5, { draft: true }),
      publishedRelease("2.0.0", 3),
      publishedRelease("v0.9.0", 1),
      publishedRelease("1.0.0", 2),
    ];
    const result = await runAction({
      core,
      env: dispatchEnvironment(),
      githubService: {
        listReleases: async () => releases,
        async updateReleaseBody(id, body) {
          calls.push(["update", id, body]);
          return { ...releases.find((release) => release.id === id), body };
        },
      },
      gitRepository: gitStub(calls),
      createModelClient: () => ({}),
      async generateNotes(_model, _comparison, options) {
        calls.push(["generate", options.version.raw]);
        return options.version.raw === "2.0.0"
          ? { hasReleaseChanges: false, notes: "" }
          : {
              hasReleaseChanges: true,
              notes: `### Changed\n- Notes for ${options.version.raw}.`,
            };
      },
    });

    assert.deepEqual(
      calls.filter((call) => call[0] === "resolve"),
      [
        ["resolve", "refs/tags/1.0.0"],
        ["resolve", "refs/tags/2.0.0"],
        ["resolve", "refs/tags/3.0.0"],
      ],
    );
    assert.deepEqual(
      calls.filter((call) => call[0] === "update"),
      [
        ["update", 2, "### Changed\n- Notes for 1.0.0."],
        ["update", 4, "### Changed\n- Notes for 3.0.0."],
      ],
    );
    assert.deepEqual(
      result.map((release) => release.tag_name),
      ["1.0.0", "3.0.0"],
    );
    assert.match(core.warningMessages.join("\n"), /Skipped v0\.9\.0/);
    assert.match(
      core.warningMessages.join("\n"),
      /Skipped 2\.0\.0: no changes/,
    );
    assert.match(core.infoMessages.at(-1), /Regenerated 2 releases, skipped 2/);
    assert.equal(core.outputs.size, 0);
  });

  it("keeps regenerating after a failure and then fails listing it", async () => {
    const updated = [];
    await assert.rejects(
      runAction({
        core: coreStub({ "regenerate-all": "true" }),
        env: dispatchEnvironment(),
        githubService: {
          listReleases: async () => [
            publishedRelease("1.0.0", 1),
            publishedRelease("2.0.0", 2),
          ],
          async updateReleaseBody(id, body) {
            updated.push(id);
            return { id, body, html_url: `https://github.test/${id}` };
          },
        },
        gitRepository: gitStub(),
        createModelClient: () => ({}),
        async generateNotes(_model, _comparison, options) {
          if (options.version.raw === "1.0.0") {
            throw new Error("model unavailable");
          }
          return { hasReleaseChanges: true, notes: "### Fixed\n- A fix." };
        },
      }),
      /Regenerated 1 release, skipped 0, failed 1\. Releases that failed were left unchanged: 1\.0\.0\./,
    );
    assert.deepEqual(updated, [2]);
  });

  it("validates the regenerate-all dispatch inputs", async () => {
    for (const [inputs, pattern] of [
      [
        { "regenerate-all": "true", "release-tag": "2.0.0" },
        /either release-tag or regenerate-all, not both/,
      ],
      [{ "regenerate-all": "yes" }, /regenerate-all must be true or false/],
      [
        { "regenerate-all": "true", "upstream-tag": "1.2.3" },
        /upstream-tag .* must be auto with regenerate-all/,
      ],
      [
        { "regenerate-all": "false" },
        /release-tag is required .* unless regenerate-all is true/,
      ],
    ]) {
      await assert.rejects(
        runAction({ core: coreStub(inputs), env: dispatchEnvironment() }),
        pattern,
      );
    }
    await assert.rejects(
      runAction({
        core: coreStub({ "regenerate-all": "true" }),
        env: dispatchEnvironment(),
        githubService: {
          listReleases: async () => [
            publishedRelease("1.0.0", 1, { draft: true }),
          ],
        },
      }),
      /No published release exists; nothing was changed/,
    );
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

  it("warns when only prereleases precede the first stable release", async () => {
    const calls = [];
    const core = coreStub();
    await runAction({
      core,
      env: pushEnvironment(),
      githubService: {
        listReleases: async () => [
          publishedRelease("2.0.0-rc.1", 1, { prerelease: true }),
        ],
      },
      gitRepository: gitStub(calls),
      createModelClient: () => ({}),
      generateNotes: async () => ({
        hasReleaseChanges: true,
        notes: "### Added\n- New behavior.",
      }),
      resolveReleaseAssets: async () => [],
      publishRelease: async () => publishedRelease("2.0.0", 2),
    });

    assert.deepEqual(
      calls.find((call) => call[0] === "compare"),
      ["compare", null, "target-sha"],
    );
    assert.match(core.warningMessages[0], /stable Semantic Version release/);
  });

  it("resolves model defaults from the explicit API format", async () => {
    for (const [inputs, expected] of [
      [
        { "api-format": "anthropic", "base-url": "", model: "" },
        {
          apiFormat: "anthropic",
          baseUrl: "https://api.anthropic.com",
          model: "claude-opus-5-5",
        },
      ],
      [
        { "base-url": "", model: "" },
        {
          apiFormat: "openai",
          baseUrl: "https://api.openai.com/v1",
          model: "gpt-5.6-luna",
        },
      ],
      [
        { "api-format": "anthropic" },
        {
          apiFormat: "anthropic",
          baseUrl: "https://api.example.test",
          model: "example-model",
        },
      ],
    ]) {
      let modelOptions;
      await runAction({
        core: coreStub(inputs),
        env: pushEnvironment(),
        githubService: {
          listReleases: async () => [publishedRelease("1.0.0", 1)],
        },
        gitRepository: gitStub(),
        createModelClient: (options) => {
          modelOptions = options;
          return {};
        },
        generateNotes: async () => ({
          hasReleaseChanges: true,
          notes: "### Added\n- New behavior.",
        }),
        resolveReleaseAssets: async () => [],
        publishRelease: async () => publishedRelease("2.0.0", 2),
      });
      const { apiFormat, baseUrl, model } = modelOptions;
      assert.deepEqual({ apiFormat, baseUrl, model }, expected);
    }
  });

  it("rejects an unknown API format before contacting GitHub", async () => {
    await assert.rejects(
      runAction({
        core: coreStub({ "api-format": "auto" }),
        env: pushEnvironment(),
        githubService: {
          listReleases: async () => {
            throw new Error("GitHub must not be contacted");
          },
        },
      }),
      /api-format must be one of: openai, openai-chat, anthropic/,
    );
  });
});
