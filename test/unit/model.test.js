import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ChatCompletionsClient,
  chatCompletionsUrl,
  generateReleaseNotes,
  parseModelJson,
  splitWithoutLoss,
  validateReleaseNotes,
} from "../../src/model.js";
import { EVIDENCE_POLICY, RELEASE_POLICY } from "../../src/policy.js";
import { parseSemVer } from "../../src/semver.js";

describe("OpenAI-compatible chat completions", () => {
  it("normalizes base and full endpoint URLs", () => {
    assert.equal(
      chatCompletionsUrl("https://api.deepseek.com/"),
      "https://api.deepseek.com/chat/completions",
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
                  content: '{"has_user_facing_changes":false,"notes":""}',
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

  it("supports endpoints without authentication", async () => {
    let headers;
    const client = new ChatCompletionsClient({
      baseUrl: "https://example.test",
      apiKey: "",
      model: "model",
      reasoningEffort: "high",
      requestOptions: {},
      timeoutSeconds: 2,
      fetchImpl: async (_url, options) => {
        headers = options.headers;
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: '```json\n{"ok":true}\n```' } }],
          }),
        };
      },
    });
    assert.deepEqual(await client.complete([]), { ok: true });
    assert.equal("authorization" in headers, false);
  });

  it("splits comparisons without dropping or duplicating text", () => {
    const comparison = `${"a".repeat(900)}\n${"b".repeat(900)}\n${"c".repeat(900)}`;
    const chunks = splitWithoutLoss(comparison, 1000);
    assert.ok(chunks.length > 1);
    assert.equal(chunks.join(""), comparison);
    assert.ok(chunks.every((chunk) => chunk.length <= 1000));
  });

  it("analyzes every comparison chunk before final synthesis", async () => {
    const calls = [];
    const comparison = `${"first change\n".repeat(100)}${"second change\n".repeat(100)}`;
    const client = {
      complete: async (messages) => {
        calls.push(messages);
        if (messages[0].content === EVIDENCE_POLICY) {
          return {
            has_user_facing_changes: true,
            evidence: [{ category: "Added", summary: `chunk ${calls.length}` }],
          };
        }
        assert.equal(messages[0].content, RELEASE_POLICY);
        return {
          has_user_facing_changes: true,
          notes: "### Added\n- Add the requested capability.",
        };
      },
    };

    const notes = await generateReleaseNotes(client, comparison, {
      version: parseSemVer("1.0.0"),
      baselineTag: null,
      fork: null,
      maxChunk: 1000,
    });
    const sentChunks = calls
      .filter((messages) => messages[0].content === EVIDENCE_POLICY)
      .map(
        (messages) =>
          messages[1].content.match(
            /<repository-comparison>\n([\s\S]*)\n<\/repository-comparison>/,
          )[1],
      );
    assert.equal(sentChunks.join(""), comparison);
    assert.equal(notes, "### Added\n- Add the requested capability.");
  });

  it("rejects malformed or empty release notes", () => {
    assert.deepEqual(parseModelJson('```json\n{"value":1}\n```'), { value: 1 });
    assert.throws(
      () => validateReleaseNotes({ has_user_facing_changes: false, notes: "" }),
      /No user-facing changes/,
    );
    assert.throws(
      () =>
        validateReleaseNotes({
          has_user_facing_changes: true,
          notes: "### Fixed\ntext",
        }),
      /only allowed/,
    );
  });
});
