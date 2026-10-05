import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  ChatCompletionsClient,
  DEFAULT_MODEL_CONFIGURATION,
  MODEL_API_FORMATS,
  MessagesClient,
  ResponsesClient,
  chatCompletionsUrl,
  createModelClient,
  messagesUrl,
  modelApiFormat,
  responsesUrl,
  comparisonChunks,
  comparisonSources,
  isContextOnlyPath,
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

function responsesPayload(text, overrides = {}) {
  return {
    status: "completed",
    output: [
      { type: "reasoning", summary: [] },
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
    ...overrides,
  };
}

function responsesResponse(text, overrides) {
  return { ok: true, json: async () => responsesPayload(text, overrides) };
}

describe("OpenAI-compatible responses", () => {
  it("defaults metadata and runtime configuration to GPT-5.6 Luna at xhigh effort", () => {
    assert.deepEqual(DEFAULT_MODEL_CONFIGURATION, {
      apiFormat: "openai",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-5.6-luna",
      reasoningEffort: "xhigh",
      maxChunk: 200000,
      timeoutSeconds: 300,
    });
    assert.deepEqual(MODEL_API_FORMATS.anthropic, {
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5-5",
    });
    assert.equal(
      responsesUrl(DEFAULT_MODEL_CONFIGURATION.baseUrl),
      "https://api.openai.com/v1/responses",
    );

    const metadata = readFileSync(
      new URL("../../action.yaml", import.meta.url),
      "utf8",
    );
    const inputs = Object.fromEntries(
      [...metadata.matchAll(/^  ([a-z][a-z-]+):\n((?:    .*\n)*)/gm)].map(
        ([, input, body]) => [input, body],
      ),
    );
    const inputDefault = (input) =>
      inputs[input].match(/^    default: (.+)$/m)?.[1];
    assert.equal(
      inputDefault("api-format"),
      DEFAULT_MODEL_CONFIGURATION.apiFormat,
    );
    assert.equal(
      inputDefault("reasoning-effort"),
      DEFAULT_MODEL_CONFIGURATION.reasoningEffort,
    );
    for (const [input, field] of [
      ["base-url", "baseUrl"],
      ["model", "model"],
    ]) {
      assert.equal(inputDefault(input), undefined);
      for (const defaults of Object.values(MODEL_API_FORMATS)) {
        assert.ok(inputs[input].includes(defaults[field]));
      }
    }
  });

  it("appends the SDK endpoint path to the base URL", () => {
    assert.equal(
      responsesUrl("https://api.openai.com/v1/"),
      "https://api.openai.com/v1/responses",
    );
    assert.equal(
      responsesUrl(" https://example.test/api/v1 "),
      "https://example.test/api/v1/responses",
    );
    assert.throws(() => responsesUrl("  "), /base-url cannot be empty/);
  });

  it("uses optional bearer auth, developer policy, and protected request fields", async () => {
    let request;
    const client = new ResponsesClient({
      baseUrl: "https://example.test/v1",
      apiKey: "secret-value",
      model: "custom-model",
      reasoningEffort: "none",
      requestOptions: {
        temperature: 0.2,
        model: "ignored",
        stream: true,
        input: "ignored",
        instructions: "ignored",
        text: { verbosity: "low" },
      },
      timeoutSeconds: 2,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return responsesResponse('{"has_release_changes":false,"notes":""}');
      },
    });

    assert.deepEqual(
      await client.complete([
        { role: "system", content: "policy" },
        { role: "user", content: "input" },
      ]),
      { has_release_changes: false, notes: "" },
    );
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, "https://example.test/v1/responses");
    assert.equal(request.options.headers.authorization, "Bearer secret-value");
    assert.equal(body.model, "custom-model");
    assert.equal(body.stream, false);
    assert.equal(body.store, false);
    assert.equal(body.temperature, 0.2);
    assert.equal("instructions" in body, false);
    assert.deepEqual(body.input, [
      { role: "developer", content: "policy" },
      { role: "user", content: "input" },
    ]);
    assert.deepEqual(body.text, {
      format: { type: "json_object" },
      verbosity: "low",
    });
    assert.equal("reasoning" in body, false);
    assert.equal("messages" in body, false);
  });

  it("supports endpoints without authentication and sends max reasoning", async () => {
    let request;
    const client = new ResponsesClient({
      baseUrl: "https://example.test",
      apiKey: "",
      model: "model",
      reasoningEffort: "max",
      requestOptions: {
        reasoning: { effort: "low", summary: "auto" },
        text: { format: { type: "json_schema", name: "notes", schema: {} } },
      },
      timeoutSeconds: 2,
      fetchImpl: async (_url, options) => {
        request = options;
        return responsesResponse('```json\n{"ok":true}\n```');
      },
    });
    assert.deepEqual(
      await client.complete([{ role: "user", content: "input" }]),
      { ok: true },
    );
    const body = JSON.parse(request.body);
    assert.equal("authorization" in request.headers, false);
    assert.deepEqual(body.reasoning, { effort: "max", summary: "auto" });
    assert.equal(body.text.format.type, "json_schema");
    assert.deepEqual(body.input, [{ role: "user", content: "input" }]);
  });

  it("joins text parts from every assistant message", async () => {
    const client = new ResponsesClient({
      baseUrl: "https://example.test/v1",
      apiKey: "",
      model: "model",
      reasoningEffort: "none",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async () => ({
        ok: true,
        json: async () => ({
          output: [
            {
              type: "message",
              content: [{ type: "output_text", text: '{"ok":' }],
            },
            { type: "function_call", arguments: "ignored" },
            {
              type: "message",
              content: [{ type: "output_text", text: "true}" }],
            },
          ],
        }),
      }),
    });
    assert.deepEqual(await client.complete([]), { ok: true });
  });

  it("fails clearly on refusals, incomplete, failed, and empty responses", async () => {
    for (const [payload, pattern] of [
      [
        responsesPayload("", {
          output: [
            {
              type: "message",
              content: [{ type: "refusal", refusal: "no" }],
            },
          ],
        }),
        /declined the request/,
      ],
      [
        responsesPayload('{"ok":', {
          status: "incomplete",
          incomplete_details: { reason: "max_output_tokens" },
        }),
        /raise max_output_tokens in request-options/,
      ],
      [
        responsesPayload("", {
          status: "incomplete",
          incomplete_details: { reason: "content_filter" },
        }),
        /incomplete \(reason: content_filter\)/,
      ],
      [
        responsesPayload("", {
          status: "failed",
          error: { code: "server_error", message: "secret-value broke" },
        }),
        /response failed: \*\*\* broke/,
      ],
      [responsesPayload(""), /no assistant text content/],
      [{ output: [{ type: "reasoning" }] }, /no assistant text content/],
    ]) {
      let requests = 0;
      const client = new ResponsesClient({
        baseUrl: "https://example.test/v1",
        apiKey: "secret-value",
        model: "model",
        reasoningEffort: "none",
        requestOptions: {},
        timeoutSeconds: 2,
        fetchImpl: async () => {
          requests += 1;
          return { ok: true, json: async () => payload };
        },
      });
      await assert.rejects(client.complete([]), (error) => {
        assert.match(error.message, pattern);
        assert.doesNotMatch(error.message, /secret-value/);
        return true;
      });
      assert.equal(requests, 1);
    }
  });

  it("reports sanitized provider error details without exposing the API key", async () => {
    const client = new ResponsesClient({
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
            param: "reasoning.effort",
          },
        }),
      }),
    });

    await assert.rejects(client.complete([]), (error) => {
      assert.match(error.message, /HTTP 400/);
      assert.match(error.message, /code: unsupported_parameter/);
      assert.match(error.message, /parameter: reasoning\.effort/);
      assert.match(error.message, /request: req_123/);
      assert.match(error.message, /Unsupported \*\*\* configuration/);
      assert.doesNotMatch(error.message, /secret-value/);
      assert.doesNotMatch(error.message, /\n/);
      return true;
    });
  });

  it("retries one malformed model response with a strict JSON repair prompt", async () => {
    const requests = [];
    const client = new ResponsesClient({
      baseUrl: "https://example.test",
      apiKey: "",
      model: "model",
      reasoningEffort: "none",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return responsesResponse(
          requests.length === 1
            ? "This is not JSON."
            : '{"has_release_changes":false,"notes":""}',
        );
      },
    });

    assert.deepEqual(
      await client.complete([
        { role: "system", content: "policy" },
        { role: "user", content: "input" },
      ]),
      {
        has_release_changes: false,
        notes: "",
      },
    );
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[1].input.slice(0, 2), requests[0].input);
    assert.deepEqual(requests[1].input[0], {
      role: "developer",
      content: "policy",
    });
    assert.deepEqual(requests[1].input.at(-2), {
      role: "assistant",
      content: "This is not JSON.",
    });
    assert.match(
      requests[1].input.at(-1).content,
      /exactly one valid JSON object/,
    );
  });

  it("fails after one JSON repair retry", async () => {
    let requests = 0;
    const client = new ResponsesClient({
      baseUrl: "https://example.test",
      apiKey: "",
      model: "model",
      reasoningEffort: "none",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async () => {
        requests += 1;
        return responsesResponse("still not JSON");
      },
    });

    await assert.rejects(
      client.complete([{ role: "user", content: "input" }]),
      /not valid JSON after one retry/,
    );
    assert.equal(requests, 2);
  });
});

describe("OpenAI-compatible chat completions", () => {
  function chatClient(fetchImpl, overrides = {}) {
    return new ChatCompletionsClient({
      baseUrl: "https://example.test/v1",
      apiKey: "secret-value",
      model: "custom-model",
      reasoningEffort: "xhigh",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl,
      ...overrides,
    });
  }

  function chatResponse(message, finishReason = "stop") {
    return {
      ok: true,
      json: async () => ({
        choices: [{ message, finish_reason: finishReason }],
      }),
    };
  }

  it("appends the SDK endpoint path to the base URL", () => {
    assert.equal(
      chatCompletionsUrl("https://api.openai.com/v1/"),
      "https://api.openai.com/v1/chat/completions",
    );
    assert.equal(
      chatCompletionsUrl(" https://example.test/api/v1 "),
      "https://example.test/api/v1/chat/completions",
    );
  });

  it("sends bearer auth, JSON mode, effort, and protected fields", async () => {
    let request;
    const client = chatClient(
      async (url, options) => {
        request = { url, options };
        return chatResponse({ content: '{"ok":true}' });
      },
      {
        requestOptions: {
          temperature: 0.2,
          reasoning_effort: "low",
          model: "ignored",
          messages: "ignored",
          stream: true,
        },
      },
    );

    const messages = [
      { role: "system", content: "policy" },
      { role: "user", content: "input" },
    ];
    assert.deepEqual(await client.complete(messages), { ok: true });
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, "https://example.test/v1/chat/completions");
    assert.equal(request.options.headers.authorization, "Bearer secret-value");
    assert.equal(body.model, "custom-model");
    assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.response_format, { type: "json_object" });
    assert.equal(body.reasoning_effort, "xhigh");
    assert.equal(body.temperature, 0.2);
    assert.equal(body.stream, false);
  });

  it("omits auth and effort when they are not configured", async () => {
    let request;
    const client = chatClient(
      async (_url, options) => {
        request = options;
        return chatResponse({ content: '{"ok":true}' });
      },
      { apiKey: "", reasoningEffort: "none" },
    );
    await client.complete([{ role: "user", content: "input" }]);
    assert.equal("authorization" in request.headers, false);
    assert.equal("reasoning_effort" in JSON.parse(request.body), false);
  });

  it("fails clearly on refusals, truncated, and empty responses", async () => {
    for (const [message, finishReason, pattern] of [
      [{ content: null, refusal: "no" }, "stop", /declined the request/],
      [{ content: '{"ok":' }, "length", /raise max_completion_tokens/],
      [{ content: null }, "stop", /no assistant text content/],
    ]) {
      let requests = 0;
      const client = chatClient(async () => {
        requests += 1;
        return chatResponse(message, finishReason);
      });
      await assert.rejects(client.complete([]), pattern);
      assert.equal(requests, 1);
    }
  });
});

describe("Anthropic-compatible messages", () => {
  function messagesResponse(text, overrides = {}) {
    return {
      ok: true,
      json: async () => ({
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text },
        ],
        stop_reason: "end_turn",
        ...overrides,
      }),
    };
  }

  it("appends the SDK endpoint path to the base URL", () => {
    assert.equal(
      messagesUrl("https://api.anthropic.com/"),
      "https://api.anthropic.com/v1/messages",
    );
    assert.equal(
      messagesUrl("https://example.test/proxy"),
      "https://example.test/proxy/v1/messages",
    );
    assert.throws(() => messagesUrl("  "), /base-url cannot be empty/);
  });

  it("sends x-api-key auth, a top-level system prompt, and effort", async () => {
    let request;
    const client = new MessagesClient({
      baseUrl: "https://example.test",
      apiKey: "secret-value",
      model: "claude-model",
      reasoningEffort: "xhigh",
      requestOptions: {
        max_tokens: 64000,
        output_config: { effort: "low", task_budget: "kept" },
        system: "ignored",
        model: "ignored",
        stream: true,
      },
      timeoutSeconds: 2,
      fetchImpl: async (url, options) => {
        request = { url, options };
        return messagesResponse('{"has_release_changes":false,"notes":""}');
      },
    });

    assert.deepEqual(
      await client.complete([
        { role: "system", content: "policy" },
        { role: "user", content: "input" },
      ]),
      { has_release_changes: false, notes: "" },
    );
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, "https://example.test/v1/messages");
    assert.equal(request.options.headers["x-api-key"], "secret-value");
    assert.equal(request.options.headers["anthropic-version"], "2023-06-01");
    assert.equal("authorization" in request.options.headers, false);
    assert.equal(body.model, "claude-model");
    assert.equal(body.max_tokens, 64000);
    assert.equal(body.stream, false);
    assert.equal(body.system, "policy");
    assert.deepEqual(body.messages, [{ role: "user", content: "input" }]);
    assert.deepEqual(body.output_config, {
      effort: "xhigh",
      task_budget: "kept",
    });
    assert.equal("text" in body, false);
  });

  it("supports endpoints without authentication or effort", async () => {
    let request;
    const client = new MessagesClient({
      baseUrl: "http://localhost:8317",
      apiKey: "",
      model: "model",
      reasoningEffort: "none",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async (_url, options) => {
        request = options;
        return messagesResponse('```json\n{"ok":true}\n```');
      },
    });

    assert.deepEqual(
      await client.complete([{ role: "user", content: "input" }]),
      { ok: true },
    );
    const body = JSON.parse(request.body);
    assert.equal("x-api-key" in request.headers, false);
    assert.equal(body.max_tokens, 32000);
    assert.equal("output_config" in body, false);
    assert.equal("system" in body, false);
  });

  it("retries malformed JSON with an appended repair turn", async () => {
    const requests = [];
    const client = new MessagesClient({
      baseUrl: "https://example.test",
      apiKey: "",
      model: "model",
      reasoningEffort: "none",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async (_url, options) => {
        requests.push(JSON.parse(options.body));
        return messagesResponse(
          requests.length === 1 ? "This is not JSON." : '{"ok":true}',
        );
      },
    });

    assert.deepEqual(
      await client.complete([
        { role: "system", content: "policy" },
        { role: "user", content: "input" },
      ]),
      { ok: true },
    );
    assert.equal(requests[1].system, "policy");
    assert.deepEqual(requests[1].messages, [
      { role: "user", content: "input" },
      { role: "assistant", content: "This is not JSON." },
      { role: "user", content: requests[1].messages[2].content },
    ]);
    assert.match(requests[1].messages[2].content, /exactly one valid JSON/);
  });

  it("fails clearly on refusals, truncated, and empty responses", async () => {
    for (const [text, stopReason, pattern] of [
      ['{"ok":', "refusal", /declined the request/],
      ['{"ok":', "max_tokens", /raise max_tokens in request-options/],
      ["", "end_turn", /no assistant text content/],
    ]) {
      let requests = 0;
      const client = new MessagesClient({
        baseUrl: "https://example.test",
        apiKey: "",
        model: "model",
        reasoningEffort: "none",
        requestOptions: {},
        timeoutSeconds: 2,
        fetchImpl: async () => {
          requests += 1;
          return messagesResponse(text, { stop_reason: stopReason });
        },
      });
      await assert.rejects(client.complete([]), pattern);
      assert.equal(requests, 1);
    }
  });

  it("reports sanitized Anthropic error details", async () => {
    const client = new MessagesClient({
      baseUrl: "https://example.test",
      apiKey: "secret-value",
      model: "model",
      reasoningEffort: "xhigh",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async () => ({
        ok: false,
        status: 401,
        headers: {
          get: (name) => (name === "request-id" ? "req_456" : null),
        },
        json: async () => ({
          type: "error",
          error: {
            type: "authentication_error",
            message: "invalid x-api-key secret-value",
          },
        }),
      }),
    });

    await assert.rejects(client.complete([]), (error) => {
      assert.match(error.message, /HTTP 401/);
      assert.match(error.message, /type: authentication_error/);
      assert.match(error.message, /request: req_456/);
      assert.match(error.message, /invalid x-api-key \*\*\*/);
      assert.doesNotMatch(error.message, /secret-value/);
      return true;
    });
  });

  it("selects the client from an explicit API format", () => {
    const options = {
      baseUrl: "http://localhost:8317/v1",
      apiKey: "",
      model: "model",
      reasoningEffort: "none",
      requestOptions: {},
      timeoutSeconds: 2,
    };
    assert.ok(
      createModelClient({ ...options, apiFormat: "openai" }) instanceof
        ResponsesClient,
    );
    assert.ok(
      createModelClient({ ...options, apiFormat: "openai-chat" }) instanceof
        ChatCompletionsClient,
    );
    assert.ok(
      createModelClient({ ...options, apiFormat: "anthropic" }) instanceof
        MessagesClient,
    );
    assert.equal(modelApiFormat(" anthropic "), "anthropic");
    for (const format of ["", "auto", "Anthropic", "claude"]) {
      assert.throws(() => modelApiFormat(format), /must be one of/);
    }
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

  it("keeps public source, API specs, and container images as primary", () => {
    for (const path of [
      "src/commands/build/run.ts",
      "packages/cli/src/dist/format.js",
      "lib/coverage/report.rb",
      "spec/openapi.yaml",
      "specs/api.yaml",
      "Dockerfile",
      "docker/app/Dockerfile",
      "build.gradle",
    ]) {
      assert.equal(isContextOnlyPath(path), false, path);
    }
    for (const path of [
      "build/output.js",
      "packages/cli/dist/index.js",
      "coverage/lcov.info",
      "spec/models/user_spec.rb",
      "pkg/server/handler_test.go",
      "tests/test_api.py",
      "app/test_settings.py",
      "src/run.spec.ts",
      ".github/workflows/CI.yaml",
      "Makefile",
    ]) {
      assert.equal(isContextOnlyPath(path), true, path);
    }
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
