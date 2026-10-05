import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  generateReleaseNotesPreview,
  previewDocument,
  previewModelConfiguration,
  previewRepository,
} from "../../src/preview.js";
import { releasePolicies } from "../../src/policy.js";

describe("release-note previews", () => {
  it("resolves an optional owner/repository input", () => {
    assert.equal(
      previewRepository("", "neurekadev/create-release-action"),
      "neurekadev/create-release-action",
    );
    assert.equal(
      previewRepository("octo-org/example", "fallback/repository"),
      "octo-org/example",
    );
    assert.throws(
      () => previewRepository("not a repository", "fallback/repository"),
      /owner\/name/,
    );
  });

  it("uses the action model defaults when no provider is configured", () => {
    assert.deepEqual(previewModelConfiguration({}), {
      apiFormat: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
    });
  });

  it("reads the provider configuration from the environment", () => {
    assert.deepEqual(
      previewModelConfiguration({
        MODEL: "claude-opus-5-5",
        MODEL_API_FORMAT: "anthropic",
        MODEL_BASE_URL: "https://agents.neureka.dev",
        MODEL_REASONING_EFFORT: "high",
      }),
      {
        apiFormat: "anthropic",
        baseUrl: "https://agents.neureka.dev",
        model: "claude-opus-5-5",
        reasoningEffort: "high",
      },
    );
    assert.deepEqual(
      previewModelConfiguration({ MODEL_API_FORMAT: "anthropic" }),
      {
        apiFormat: "anthropic",
        baseUrl: "https://api.anthropic.com",
        model: "claude-opus-5-5",
        reasoningEffort: "xhigh",
      },
    );
    assert.throws(
      () => previewModelConfiguration({ MODEL_API_FORMAT: "gemini" }),
      /api-format must be one of/,
    );
  });

  it("compares target HEAD with the newest reachable published release", async () => {
    let comparisonArguments;
    const policies = releasePolicies("end-user");
    const github = {
      getRepository: async () => ({
        private: false,
        full_name: "octo-org/example",
      }),
      listReleases: async () => [
        { tag_name: "2.0.0", draft: false, published_at: "2026-02-01" },
        { tag_name: "1.0.0", draft: false, published_at: "2026-01-01" },
      ],
    };
    const git = {
      resolveCommit: async () => "target-sha",
      hasCommit: async () => true,
      isAncestor: async (tag) => tag === "1.0.0",
      buildComparison: async (...parameters) => {
        comparisonArguments = parameters;
        return "small product change";
      },
    };
    const client = {
      complete: async (messages) => {
        if (messages[0].content === policies.evidence) {
          return {
            has_release_changes: true,
            evidence: [
              { category: "Changed", summary: "Make releases clearer." },
            ],
          };
        }
        if (messages[0].content === policies.filter) {
          return {
            has_release_changes: true,
            evidence: [
              {
                category: "Changed",
                summary: "Make releases clearer.",
                source_role: "primary",
              },
            ],
          };
        }
        return {
          has_release_changes: true,
          notes: "### Changed\n- Make release updates easier to understand.",
        };
      },
    };

    const preview = await generateReleaseNotesPreview({
      audience: "end-user",
      client,
      git,
      github,
      maxChunk: 1000,
      targetRepository: "octo-org/example",
      workflowRepository: "neurekadev/create-release-action",
    });
    assert.deepEqual(comparisonArguments, ["1.0.0", "target-sha"]);
    assert.equal(preview.baselineTag, "1.0.0");
    assert.equal(preview.targetCommit, "target-sha");
    assert.match(previewDocument(preview), /Make release updates easier/);
  });

  it("allows the workflow repository but rejects external private repositories", async () => {
    const common = {
      audience: "maintainer",
      client: {},
      git: {},
      maxChunk: 1000,
      targetRepository: "private/target",
      workflowRepository: "workflow/source",
    };
    await assert.rejects(
      generateReleaseNotesPreview({
        ...common,
        github: { getRepository: async () => ({ private: true }) },
      }),
      /public repositories only/,
    );
  });

  it("renders a successful no-change preview instead of failing", async () => {
    const policies = releasePolicies("technical");
    const preview = await generateReleaseNotesPreview({
      audience: "technical",
      client: {
        complete: async (messages) => {
          assert.equal(messages[0].content, policies.evidence);
          return { has_release_changes: false, evidence: [] };
        },
      },
      git: {
        resolveCommit: async () => "target-sha",
        buildComparison: async () => "no qualifying change",
      },
      github: {
        getRepository: async () => ({ private: false }),
        listReleases: async () => [],
      },
      maxChunk: 1000,
      targetRepository: "octo-org/example",
      workflowRepository: "workflow/source",
    });
    assert.equal(preview.hasReleaseChanges, false);
    assert.match(previewDocument(preview), /No changes qualify/);
  });
});
