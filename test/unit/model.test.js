import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ChatCompletionsClient,
  DEFAULT_MODEL_CONFIGURATION,
  chatCompletionsUrl,
  comparisonChunks,
  comparisonSources,
  generateReleaseNotes,
  parseModelJson,
  splitWithoutLoss,
  validateReleaseNotes,
} from "../../src/model.js";
import { releaseNoteAudience, releasePolicies } from "../../src/policy.js";
import { parseSemVer } from "../../src/semver.js";

function comparison(...patches) {
  return [
    "Comparison: 1.0.0 -> head",
    "",
    "=== COMMITS ===",
    "commit abc",
    "Subject: improve the product",
    "",
    "=== FULL TEXTUAL DIFF ===",
    ...patches,
  ].join("\n");
}

function patch(path, body) {
  return [
    `diff --git a/${path} b/${path}`,
    `--- a/${path}`,
    `+++ b/${path}`,
    "@@ -1 +1 @@",
    body,
  ].join("\n");
}

describe("OpenAI-compatible chat completions", () => {
  it("defaults metadata and runtime configuration to GPT-5.6 Luna at xhigh effort", () => {
    assert.deepEqual(DEFAULT_MODEL_CONFIGURATION, {
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      maxChunk: 200000,
      timeoutSeconds: 300,
    });
    assert.equal(
      chatCompletionsUrl(DEFAULT_MODEL_CONFIGURATION.baseUrl),
      "https://api.openai.com/v1/chat/completions",
    );

    const metadata = readFileSync(
      new URL("../../action.yaml", import.meta.url),
      "utf8",
    );
    const inputDefaults = Object.fromEntries(
      [
        ...metadata.matchAll(
          /^  ([a-z][a-z-]+):\n(?:    .*\n)*?    default: (.+)$/gm,
        ),
      ].map(([, input, value]) => [input, value]),
    );
    assert.equal(
      inputDefaults["base-url"],
      DEFAULT_MODEL_CONFIGURATION.baseUrl,
    );
    assert.equal(inputDefaults.model, DEFAULT_MODEL_CONFIGURATION.model);
    assert.equal(
      inputDefaults["reasoning-effort"],
      DEFAULT_MODEL_CONFIGURATION.reasoningEffort,
    );
  });

  it("normalizes base and full endpoint URLs", () => {
    assert.equal(
      chatCompletionsUrl("https://api.openai.com/v1/"),
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(
      chatCompletionsUrl("https://example.test/v1/chat/completions"),
      "https://example.test/v1/chat/completions",
    );
  });

  it("uses optional bearer auth and keeps protected request fields", async () => {
    let request;
    const client = new ChatCompletionsClient({
      baseUrl: "https://example.test/v1",
      apiKey: "secret-value",
      model: "custom-model",
      reasoningEffort: "none",
      requestOptions: { temperature: 0.2, model: "ignored", stream: true },
      timeoutSeconds: 2,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content: '{"has_release_changes":false,"notes":""}',
                },
              },
            ],
          }),
        };
      },
    });

    await client.complete([{ role: "user", content: "input" }]);
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, "https://example.test/v1/chat/completions");
    assert.equal(request.options.headers.authorization, "Bearer secret-value");
    assert.equal(body.model, "custom-model");
    assert.equal(body.stream, false);
    assert.equal(body.temperature, 0.2);
    assert.equal("reasoning_effort" in body, false);
  });

  it("supports endpoints without authentication and sends max reasoning", async () => {
    let request;
    const client = new ChatCompletionsClient({
      baseUrl: "https://example.test",
      apiKey: "",
      model: "model",
      reasoningEffort: "max",
      requestOptions: { reasoning_effort: "low" },
      timeoutSeconds: 2,
      fetchImpl: async (_url, options) => {
        request = options;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
          }),
        };
      },
    });
    assert.deepEqual(await client.complete([]), { ok: true });
    assert.equal("authorization" in request.headers, false);
    assert.equal(JSON.parse(request.body).reasoning_effort, "max");
  });

  it("reports sanitized provider error details without exposing the API key", async () => {
    const client = new ChatCompletionsClient({
      baseUrl: "https://example.test",
      apiKey: "secret-value",
      model: "model",
      reasoningEffort: "max",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        headers: {
          get: (name) => (name === "x-request-id" ? "req_123" : null),
        },
        json: async () => ({
          error: {
            code: "unsupported_parameter",
            message: "Unsupported secret-value\nconfiguration",
            param: "reasoning_effort",
          },
        }),
      }),
    });

    await assert.rejects(client.complete([]), (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /code: unsupported_parameter/);
      assert.match(error.message, /parameter: reasoning_effort/);
      assert.match(error.message, /request: req_123/);
      assert.match(error.message, /Unsupported \*\*\* configuration/);
      assert.doesNotMatch(error.message, /secret-value/);
      assert.doesNotMatch(error.message, /\n/);
      return true;
    });
  });

  it("retries one malformed model response with a strict JSON repair prompt", async () => {
    const requests = [];
    const client = new ChatCompletionsClient({
      baseUrl: "https://example.test",
      apiKey: "",
      model: "model",
      reasoningEffort: "none",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return {
          ok: true,
          json: async () => ({
            choices: [
              {
                message: {
                  content:
                    requests.length === 1
                      ? "This is not JSON."
                      : '{"has_release_changes":false,"notes":""}',
                },
              },
            ],
          }),
        };
      },
    });

    assert.deepEqual(
      await client.complete([{ role: "user", content: "input" }]),
      {
        has_release_changes: false,
        notes: "",
      },
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].messages.slice(0, 1), requests[0].messages);
    assert.deepEqual(requests[1].messages.at(-2), {
      role: "assistant",
      content: "This is not JSON.",
    });
    assert.match(
      requests[1].messages.at(-1).content,
      /exactly one valid JSON object/,
    );
  });

  it("fails after one JSON repair retry", async () => {
    let requests = 0;
    const client = new ChatCompletionsClient({
      baseUrl: "https://example.test",
      apiKey: "",
      model: "model",
      reasoningEffort: "none",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async () => {
        requests += 1;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: "still not JSON" } }],
          }),
        };
      },
    });

    await assert.rejects(
      client.complete([{ role: "user", content: "input" }]),
      /not valid JSON after one retry/,
    );
    assert.equal(requests, 2);
  });
});

describe("release-note audiences", () => {
  it("accepts the three public values and rejects everything else", () => {
    for (const audience of ["end-user", "technical", "maintainer"]) {
      assert.equal(releaseNoteAudience(audience), audience);
    }
    for (const audience of ["", "user", "nerd", "End-User"]) {
      assert.throws(() => releaseNoteAudience(audience), /must be one of/);
    }
  });

  it("defines everyday, technical, and complete writing contracts", () => {
    const endUser = releasePolicies("end-user");
    assert.match(endUser.release, /no programming knowledge/);
    assert.match(endUser.release, /There is no hard bullet limit/);
    assert.match(endUser.release, /Fetch, WebSocket/);
    assert.match(endUser.release, /Semantic Versioning, tags, baselines/);
    assert.match(endUser.release, /glob patterns/);

    const technical = releasePolicies("technical");
    assert.match(technical.release, /public API/);
    assert.match(technical.release, /operators, and integrators/);

    const maintainer = releasePolicies("maintainer");
    assert.match(
      maintainer.release,
      /every distinct product and internal change/,
    );
    assert.match(maintainer.release, /frontend performance improvements/);
  });
});

describe("provenance-aware comparisons", () => {
  it("splits text without dropping or duplicating characters", () => {
    const value = `${"a".repeat(900)}\n${"b".repeat(900)}\n${"c".repeat(900)}`;
    const chunks = splitWithoutLoss(value, 1000);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), value);
    assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  });

  it("marks generated and dependency artifacts as context-only", () => {
    const value = comparison(
      patch("src/run.js", "+make releases easier"),
      patch("dist/index.js", "+class WebSocketClient {}"),
      patch("package-lock.json", '+"undici": "7.0.0"'),
      patch("test/unit/run.test.js", "+test the behavior"),
    );
    const endUser = comparisonSources(value, "end-user");
    assert.equal(
      endUser.find((source) => source.path === "src/run.js").role,
      "primary",
    );
    for (const path of [
      "dist/index.js",
      "package-lock.json",
      "test/unit/run.test.js",
    ]) {
      assert.equal(
        endUser.find((source) => source.path === path).role,
        "context-only",
      );
    }
    assert.ok(
      comparisonSources(value, "maintainer").every(
        (source) => source.role === "primary",
      ),
    );
  });

  it("repeats source provenance across fragments without losing raw content", () => {
    const value = comparison(
      patch("src/run.js", `+${"product outcome\n".repeat(100)}`),
      patch("dist/index.js", `+${"WebSocket internals\n".repeat(100)}`),
    );
    const sources = comparisonSources(value, "end-user");
    const chunks = comparisonChunks(value, 1000, "end-user");
    const fragments = chunks.flatMap((chunk) => chunk.fragments);

    for (const source of sources) {
      const rebuilt = fragments
        .filter((fragment) => fragment.index === source.index)
        .sort((left, right) => left.fragmentIndex - right.fragmentIndex)
        .map((fragment) => fragment.content)
        .join("");
      assert.equal(rebuilt, source.content);
    }
    for (const chunk of chunks.filter((item) => item.role === "context-only")) {
      assert.match(chunk.content, /source_role="context-only"/);
      assert.match(chunk.content, /path="dist\/index.js"/);
    }
  });
});

describe("release-note generation", () => {
  it("filters a single comparison before end-user synthesis", async () => {
    const calls = [];
    const policies = releasePolicies("end-user");
    const client = {
      complete: async (messages) => {
        calls.push(messages);
        if (messages[0].content === policies.evidence) {
          return {
            has_release_changes: true,
            evidence: [
              { category: "Added", summary: "Publish releases automatically." },
            ],
          };
        }
        if (messages[0].content === policies.filter) {
          return {
            has_release_changes: true,
            evidence: [
              {
                category: "Added",
                summary: "Publish releases automatically.",
                source_role: "primary",
              },
            ],
          };
        }
        assert.equal(messages[0].content, policies.release);
        assert.doesNotMatch(messages[1].content, /WebSocketClient/);
        return {
          has_release_changes: true,
          notes: "### Added\n- Publish new versions automatically.",
        };
      },
    };

    const result = await generateReleaseNotes(
      client,
      comparison(patch("src/run.js", "+publish a version")),
      {
        audience: "end-user",
        version: parseSemVer("1.1.0"),
        baselineTag: "1.0.0",
        softFork: null,
        maxChunk: 1000,
      },
    );
    assert.equal(calls.length, 3);
    assert.deepEqual(result, {
      hasReleaseChanges: true,
      notes: "### Added\n- Publish new versions automatically.",
    });
  });

  it("prevents context-only dependency evidence from creating filtered notes", async () => {
    let finalCalls = 0;
    const policies = releasePolicies("technical");
    const client = {
      complete: async (messages) => {
        if (messages[0].content === policies.release) finalCalls += 1;
        const contextOnly = messages[1].content.includes(
          "source role: context-only",
        );
        return contextOnly
          ? {
              has_release_changes: true,
              evidence: [
                { category: "Added", summary: "Add WebSocket support." },
              ],
            }
          : { has_release_changes: false, evidence: [] };
      },
    };
    const result = await generateReleaseNotes(
      client,
      comparison(patch("dist/index.js", "+class WebSocketClient {}")),
      {
        audience: "technical",
        version: parseSemVer("1.1.0"),
        baselineTag: "1.0.0",
        softFork: null,
        maxChunk: 1000,
      },
    );
    assert.deepEqual(result, { hasReleaseChanges: false, notes: "" });
    assert.equal(finalCalls, 0);
  });

  it("uses dependency evidence only to refine a primary product outcome", async () => {
    const policies = releasePolicies("end-user");
    const client = {
      complete: async (messages) => {
        if (messages[0].content === policies.evidence) {
          return messages[1].content.includes("source role: context-only")
            ? {
                has_release_changes: true,
                evidence: [
                  {
                    category: "Added",
                    summary: "Add WebSocket and proxy agents.",
                  },
                ],
              }
            : {
                has_release_changes: true,
                evidence: [
                  {
                    category: "Added",
                    summary: "Publish release notes automatically.",
                  },
                ],
              };
        }
        if (messages[0].content === policies.filter) {
          assert.match(messages[1].content, /WebSocket and proxy agents/);
          return {
            has_release_changes: true,
            evidence: [
              {
                category: "Added",
                summary: "Publish clear release notes automatically.",
                source_role: "primary",
              },
            ],
          };
        }
        assert.equal(messages[0].content, policies.release);
        assert.doesNotMatch(messages[1].content, /WebSocket|proxy agents/);
        return {
          has_release_changes: true,
          notes: "### Added\n- Publish clear release notes automatically.",
        };
      },
    };
    const result = await generateReleaseNotes(
      client,
      comparison(
        patch("src/run.js", "+publish release notes"),
        patch("dist/index.js", "+WebSocket and proxy agents"),
      ),
      {
        audience: "end-user",
        version: parseSemVer("1.1.0"),
        baselineTag: "1.0.0",
        softFork: null,
        maxChunk: 1000,
      },
    );
    assert.equal(
      result.notes,
      "### Added\n- Publish clear release notes automatically.",
    );
  });

  it("validates structured release-note responses", () => {
    assert.deepEqual(parseModelJson('```json\n{"value":1}\n```'), {
      value: 1,
    });
    assert.deepEqual(
      validateReleaseNotes({ has_release_changes: false, notes: "" }),
      { hasReleaseChanges: false, notes: "" },
    );
    assert.throws(
      () =>
        validateReleaseNotes({
          has_release_changes: true,
          notes: "### Fixed\ntext",
        }),
      /only allowed/,
    );
  });
});
