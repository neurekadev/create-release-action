import {
  DEFAULT_RELEASE_NOTE_AUDIENCE,
  releaseContext,
  releaseNoteAudience,
  releasePolicies,
} from "./policy.js";

const RELEASE_NOTE_SECTIONS = Object.freeze([
  "Added",
  "Changed",
  "Deprecated",
  "Removed",
  "Fixed",
  "Security",
]);

const CONTEXT_ONLY_DIRECTORIES = new Set([
  ".github",
  "__fixtures__",
  "__tests__",
  "fixtures",
  "node_modules",
  "test",
  "tests",
  "third_party",
  "vendor",
]);

// Output directories are context-only unless a source root sits above their
// parent: src/commands/build/ is product source, while app/build/ and
// packages/lib/dist/ are generated output.
const GENERATED_OUTPUT_DIRECTORIES = new Set(["build", "coverage", "dist"]);

// Spec directories hold tests, except for interface definitions such as
// spec/openapi.yaml, which are public contracts.
const SPEC_DIRECTORIES = new Set(["spec", "specs"]);
const CONTRACT_FILE_PATTERN = /\.(?:graphql|gql|json|proto|ya?ml)$/;

// The underscore test suffix is conventional only in these languages, so
// product modules such as src/ab_test.ts stay primary.
const UNDERSCORE_TEST_FILE_PATTERN =
  /_(?:test|spec)\.(?:c|cc|cpp|dart|exs|go|py|rb|rs)$/;

const SOURCE_ROOT_DIRECTORIES = new Set([
  "app",
  "cmd",
  "internal",
  "lib",
  "pkg",
  "source",
  "src",
]);

const CONTEXT_ONLY_BASENAMES = new Set([
  ".editorconfig",
  ".gitattributes",
  ".gitignore",
  ".prettierignore",
  ".prettierrc",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
  "makefile",
  "npm-shrinkwrap.json",
  "package-lock.json",
  "packages.lock.json",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "taskfile.yaml",
  "taskfile.yml",
  "uv.lock",
  "yarn.lock",
]);

export const MODEL_API_FORMATS = Object.freeze({
  openai: Object.freeze({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
  }),
  "openai-chat": Object.freeze({
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-5.6-luna",
  }),
  anthropic: Object.freeze({
    baseUrl: "https://api.anthropic.com",
    model: "claude-opus-5-5",
  }),
});

export const DEFAULT_MODEL_CONFIGURATION = Object.freeze({
  apiFormat: "openai",
  ...MODEL_API_FORMATS.openai,
  reasoningEffort: "xhigh",
  maxChunk: 200000,
  timeoutSeconds: 300,
});

const ANTHROPIC_VERSION = "2023-06-01";
const MESSAGES_MAX_TOKENS = 32000;

export function modelApiFormat(value) {
  const format = value.trim();
  if (!Object.hasOwn(MODEL_API_FORMATS, format)) {
    throw new Error(
      `api-format must be one of: ${Object.keys(MODEL_API_FORMATS).join(", ")}.`,
    );
  }
  return format;
}

function endpointUrl(baseUrl, path) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("base-url cannot be empty.");
  }
  return `${trimmed}${path}`;
}

export function chatCompletionsUrl(baseUrl) {
  return endpointUrl(baseUrl, "/chat/completions");
}

export function responsesUrl(baseUrl) {
  return endpointUrl(baseUrl, "/responses");
}

export function messagesUrl(baseUrl) {
  return endpointUrl(baseUrl, "/v1/messages");
}

export function splitWithoutLoss(value, maximum) {
  if (!Number.isSafeInteger(maximum) || maximum < 1000) {
    throw new Error(
      "max-chunk must be an integer of at least 1000 characters.",
    );
  }

  const chunks = [];
  let start = 0;
  while (start < value.length) {
    let end = Math.min(start + maximum, value.length);
    if (end < value.length) {
      const newline = value.lastIndexOf("\n", end - 1);
      if (newline >= start) {
        end = newline + 1;
      }
    }
    chunks.push(value.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [""];
}

function cleanDiffPath(value) {
  let path = value.trim();
  if (path.startsWith('"') && path.endsWith('"')) {
    path = path.slice(1, -1);
  }
  return path.replace(/^[ab]\//, "");
}

function patchPath(patch) {
  const added = patch.match(/^\+\+\+ (.+)$/m)?.[1];
  if (added && added !== "/dev/null") return cleanDiffPath(added);
  const removed = patch.match(/^--- (.+)$/m)?.[1];
  if (removed && removed !== "/dev/null") return cleanDiffPath(removed);
  return "unknown";
}

export function isContextOnlyPath(value) {
  const path = value.toLowerCase().replaceAll("\\", "/");
  const parts = path.split("/").filter(Boolean);
  const basename = parts.at(-1) || "";

  const directories = parts.slice(0, -1);
  if (directories.some((part) => CONTEXT_ONLY_DIRECTORIES.has(part))) {
    return true;
  }
  if (
    directories.some((part) => SPEC_DIRECTORIES.has(part)) &&
    !CONTRACT_FILE_PATTERN.test(basename)
  ) {
    return true;
  }
  const output = directories.findIndex((part) =>
    GENERATED_OUTPUT_DIRECTORIES.has(part),
  );
  if (
    output >= 0 &&
    !directories
      .slice(0, Math.max(0, output - 1))
      .some((part) => SOURCE_ROOT_DIRECTORIES.has(part))
  ) {
    return true;
  }
  if (CONTEXT_ONLY_BASENAMES.has(basename)) return true;
  if (/\.(?:lock|min\.js|map)$/.test(basename)) return true;
  if (/\.(?:test|spec)\.[^.]+$/.test(basename)) return true;
  if (UNDERSCORE_TEST_FILE_PATTERN.test(basename)) return true;
  if (/^test_.+\.py$/.test(basename)) return true;
  return /^(?:babel|eslint|rollup|vite|webpack)\.config\./.test(basename);
}

export function comparisonSources(comparison, audienceValue) {
  const audience = releaseNoteAudience(audienceValue);
  const marker = "=== FULL TEXTUAL DIFF ===\n";
  const markerIndex = comparison.indexOf(marker);
  if (markerIndex < 0) {
    return [
      {
        index: 0,
        kind: "comparison",
        path: "repository-comparison",
        role: "primary",
        content: comparison,
      },
    ];
  }

  const diffStart = markerIndex + marker.length;
  const sources = [
    {
      index: 0,
      kind: "history",
      path: "commit-history",
      role: "primary",
      content: comparison.slice(0, diffStart),
    },
  ];
  const diff = comparison.slice(diffStart);
  const starts = [...diff.matchAll(/^diff --git /gm)].map(
    (match) => match.index,
  );

  if (starts.length === 0) {
    if (diff) {
      sources.push({
        index: sources.length,
        kind: "diff",
        path: "repository-diff",
        role: "primary",
        content: diff,
      });
    }
    return sources;
  }

  for (let index = 0; index < starts.length; index += 1) {
    const content = diff.slice(starts[index], starts[index + 1]);
    const path = patchPath(content);
    sources.push({
      index: sources.length,
      kind: "diff",
      path,
      role:
        audience !== "maintainer" && isContextOnlyPath(path)
          ? "context-only"
          : "primary",
      content,
    });
  }
  return sources;
}

function escapeAttribute(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function chunkPayload(fragments) {
  return fragments
    .map(
      (fragment) =>
        `<comparison-source path="${escapeAttribute(fragment.path)}" kind="${fragment.kind}" source_role="${fragment.role}" fragment="${fragment.fragmentIndex + 1}/${fragment.fragmentCount}">\n${fragment.content}\n</comparison-source>`,
    )
    .join("\n");
}

export function comparisonChunks(comparison, maximum, audienceValue) {
  splitWithoutLoss("", maximum);
  const sources = comparisonSources(comparison, audienceValue);
  const fragments = sources.flatMap((source) => {
    const contents = splitWithoutLoss(source.content, maximum);
    return contents.map((content, fragmentIndex) => ({
      ...source,
      content,
      fragmentIndex,
      fragmentCount: contents.length,
    }));
  });
  const chunks = [];

  for (const role of ["primary", "context-only"]) {
    let current = [];
    let currentLength = 0;
    for (const fragment of fragments.filter((item) => item.role === role)) {
      if (
        current.length > 0 &&
        currentLength + fragment.content.length > maximum
      ) {
        chunks.push({
          role,
          fragments: current,
          content: chunkPayload(current),
        });
        current = [];
        currentLength = 0;
      }
      current.push(fragment);
      currentLength += fragment.content.length;
    }
    if (current.length > 0) {
      chunks.push({
        role,
        fragments: current,
        content: chunkPayload(current),
      });
    }
  }
  return chunks;
}

export function parseModelJson(content) {
  const trimmed = content.trim();
  const unwrapped = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    throw new InvalidModelJsonError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The model response must be a JSON object.");
  }
  return parsed;
}

class InvalidModelJsonError extends Error {
  constructor() {
    super("The model response was not valid JSON.");
    this.name = "InvalidModelJsonError";
  }
}

function messageText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((item) => item?.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("");
  }
  throw new Error("The model endpoint returned no assistant message content.");
}

const JSON_REPAIR_PROMPT =
  "Your previous response was not valid JSON. Return the same answer as exactly one valid JSON object that follows the originally requested schema. Do not include Markdown fences or commentary.";

function safeProviderErrorValue(value, apiKey) {
  if (typeof value !== "string") return "";
  let result = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (apiKey) result = result.replaceAll(apiKey, "***");
  return result.slice(0, 500);
}

async function modelHttpError(response, apiKey) {
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }

  const details = [];
  for (const [label, value] of [
    ["code", payload?.error?.code],
    ["type", payload?.error?.type],
    ["parameter", payload?.error?.param],
    [
      "request",
      response.headers?.get?.("x-request-id") ||
        response.headers?.get?.("request-id"),
    ],
  ]) {
    const safeValue = safeProviderErrorValue(value, apiKey);
    if (safeValue) details.push(`${label}: ${safeValue}`);
  }
  const suffix = details.length ? ` (${details.join(", ")})` : "";
  const message = safeProviderErrorValue(payload?.error?.message, apiKey);
  const explanation = message ? `: ${message}` : "";
  return new Error(
    `The model endpoint returned HTTP ${response.status}${suffix}${explanation}.`,
  );
}

class JsonModelClient {
  constructor(url, options) {
    this.url = url;
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.requestOptions = options.requestOptions;
    this.timeoutMilliseconds = options.timeoutSeconds * 1000;
    this.fetch = options.fetchImpl || fetch;
  }

  get sendsReasoningEffort() {
    return Boolean(this.reasoningEffort) && this.reasoningEffort !== "none";
  }

  async complete(messages) {
    let requestMessages = messages;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.timeoutMilliseconds,
      );

      try {
        const response = await this.fetch(this.url, {
          method: "POST",
          headers: this.requestHeaders(),
          body: JSON.stringify(this.requestBody(requestMessages)),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw await modelHttpError(response, this.apiKey);
        }
        const content = this.responseText(await response.json());
        if (!content.trim()) {
          throw new Error(
            "The model endpoint returned no assistant text content.",
          );
        }
        try {
          return parseModelJson(content);
        } catch (error) {
          if (!(error instanceof InvalidModelJsonError)) {
            throw error;
          }
          if (attempt > 0) {
            throw new Error(
              "The model response was not valid JSON after one retry.",
            );
          }
          requestMessages = [
            ...messages,
            { role: "assistant", content },
            { role: "user", content: JSON_REPAIR_PROMPT },
          ];
        }
      } catch (error) {
        if (error?.name === "AbortError") {
          throw new Error(
            `The model request exceeded ${this.timeoutMilliseconds / 1000} seconds.`,
          );
        }
        throw error;
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error("The model response could not be completed.");
  }
}

function splitSystemMessages(messages) {
  return {
    system: messages
      .filter((message) => message.role === "system")
      .map((message) => message.content)
      .join("\n\n"),
    conversation: messages.filter((message) => message.role !== "system"),
  };
}

export class ResponsesClient extends JsonModelClient {
  constructor(options) {
    super(responsesUrl(options.baseUrl), options);
  }

  requestHeaders() {
    const headers = { "content-type": "application/json" };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  requestBody(messages) {
    const body = {
      model: this.model,
      store: false,
      ...this.requestOptions,
      stream: false,
    };
    body.text = { format: { type: "json_object" }, ...body.text };
    if (this.sendsReasoningEffort) {
      body.reasoning = { ...body.reasoning, effort: this.reasoningEffort };
    }
    delete body.instructions;
    body.model = this.model;
    body.input = messages.map((message) =>
      message.role === "system" ? { ...message, role: "developer" } : message,
    );
    return body;
  }

  responseText(payload) {
    if (payload?.status === "incomplete") {
      const reason = safeProviderErrorValue(
        payload.incomplete_details?.reason,
        this.apiKey,
      );
      if (reason === "max_output_tokens") {
        throw new Error(
          "The model response reached max_output_tokens before completing; raise max_output_tokens in request-options.",
        );
      }
      throw new Error(
        `The model response was incomplete${reason ? ` (reason: ${reason})` : ""}.`,
      );
    }
    if (payload?.status === "failed") {
      const message = safeProviderErrorValue(
        payload.error?.message,
        this.apiKey,
      );
      throw new Error(
        `The model response failed${message ? `: ${message}` : ""}.`,
      );
    }
    const parts = (Array.isArray(payload?.output) ? payload.output : [])
      .filter((item) => item?.type === "message")
      .flatMap((item) => (Array.isArray(item.content) ? item.content : []));
    if (parts.some((part) => part?.type === "refusal")) {
      throw new Error("The model declined the request (refusal).");
    }
    return parts
      .filter(
        (part) => part?.type === "output_text" && typeof part.text === "string",
      )
      .map((part) => part.text)
      .join("");
  }
}

export class ChatCompletionsClient extends JsonModelClient {
  constructor(options) {
    super(chatCompletionsUrl(options.baseUrl), options);
  }

  requestHeaders() {
    const headers = { "content-type": "application/json" };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  requestBody(messages) {
    const body = {
      model: this.model,
      response_format: { type: "json_object" },
      ...this.requestOptions,
      stream: false,
    };
    if (this.sendsReasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }
    body.model = this.model;
    body.messages = messages;
    return body;
  }

  responseText(payload) {
    const choice = payload?.choices?.[0];
    if (choice?.message?.refusal) {
      throw new Error("The model declined the request (refusal).");
    }
    if (choice?.finish_reason === "length") {
      throw new Error(
        "The model response reached its token limit before completing; raise max_completion_tokens in request-options.",
      );
    }
    return messageText(choice?.message?.content ?? "");
  }
}

export class MessagesClient extends JsonModelClient {
  constructor(options) {
    super(messagesUrl(options.baseUrl), options);
  }

  requestHeaders() {
    const headers = {
      "content-type": "application/json",
      "anthropic-version": ANTHROPIC_VERSION,
    };
    if (this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }
    return headers;
  }

  requestBody(messages) {
    const { system, conversation } = splitSystemMessages(messages);
    const body = {
      model: this.model,
      max_tokens: MESSAGES_MAX_TOKENS,
      ...this.requestOptions,
      stream: false,
    };
    if (this.sendsReasoningEffort) {
      body.output_config = {
        ...body.output_config,
        effort: this.reasoningEffort,
      };
    }
    if (system) body.system = system;
    body.model = this.model;
    body.messages = conversation;
    return body;
  }

  responseText(payload) {
    if (payload?.stop_reason === "refusal") {
      throw new Error("The model declined the request (stop reason: refusal).");
    }
    if (payload?.stop_reason === "max_tokens") {
      throw new Error(
        "The model response reached max_tokens before completing; raise max_tokens in request-options.",
      );
    }
    return messageText(payload?.content);
  }
}

const MODEL_CLIENTS = Object.freeze({
  openai: ResponsesClient,
  "openai-chat": ChatCompletionsClient,
  anthropic: MessagesClient,
});

export function createModelClient(options) {
  const Client = MODEL_CLIENTS[modelApiFormat(options.apiFormat)];
  return new Client(options);
}

function validateEvidenceItem(item, requireSourceRole) {
  if (
    !item ||
    typeof item !== "object" ||
    !RELEASE_NOTE_SECTIONS.includes(item.category) ||
    typeof item.summary !== "string" ||
    !item.summary.trim()
  ) {
    throw new Error("The model returned an invalid evidence item.");
  }
  if (
    requireSourceRole &&
    !["primary", "context-only"].includes(item.source_role)
  ) {
    throw new Error("The model returned evidence without valid provenance.");
  }
  return {
    category: item.category,
    summary: item.summary.trim(),
    ...(requireSourceRole ? { source_role: item.source_role } : {}),
  };
}

function validateEvidence(response, options = {}) {
  if (
    typeof response.has_release_changes !== "boolean" ||
    !Array.isArray(response.evidence)
  ) {
    throw new Error("The model returned an invalid evidence object.");
  }
  const evidence = response.evidence.map((item) =>
    validateEvidenceItem(item, options.requireSourceRole),
  );
  if (!response.has_release_changes && evidence.length > 0) {
    throw new Error("The model returned contradictory release evidence.");
  }
  return { has_release_changes: response.has_release_changes, evidence };
}

export function validateReleaseNotes(response) {
  if (
    typeof response.has_release_changes !== "boolean" ||
    typeof response.notes !== "string"
  ) {
    throw new Error("The model returned an invalid release-note object.");
  }
  if (!response.has_release_changes) {
    if (response.notes.trim()) {
      throw new Error("The model returned notes without qualifying changes.");
    }
    return { hasReleaseChanges: false, notes: "" };
  }

  const notes = response.notes.trim();
  let lastSection = -1;
  let bullets = 0;
  for (const line of notes.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("### ")) {
      const index = RELEASE_NOTE_SECTIONS.indexOf(line.slice(4).trim());
      if (index < 0 || index <= lastSection) {
        throw new Error(
          "Release-note sections are invalid, duplicated, or out of order.",
        );
      }
      lastSection = index;
    } else if (line.startsWith("- ") && lastSection >= 0) {
      bullets += 1;
    } else {
      throw new Error(
        "Release notes must contain only allowed level-three sections and bullets.",
      );
    }
  }
  if (bullets === 0) {
    throw new Error(
      "The model reported qualifying changes without any release-note bullets.",
    );
  }
  return { hasReleaseChanges: true, notes };
}

async function reduceEvidence(client, evidence, maxChunk, policy) {
  let current = evidence;
  for (let round = 0; round < 10; round += 1) {
    const serialized = JSON.stringify(current);
    if (serialized.length <= maxChunk) return current;

    const chunks = splitWithoutLoss(serialized, maxChunk);
    const reduced = [];
    for (const chunk of chunks) {
      reduced.push(
        validateEvidence(
          await client.complete([
            { role: "system", content: policy },
            {
              role: "user",
              content: `<release-evidence>\n${chunk}\n</release-evidence>`,
            },
          ]),
          { requireSourceRole: true },
        ),
      );
    }
    const next = reduced.flatMap((item) => item.evidence);
    if (
      JSON.stringify(next).length >= serialized.length &&
      reduced.length > 1
    ) {
      throw new Error(
        "The model could not reduce chunk evidence within max-chunk without truncation.",
      );
    }
    current = next;
  }
  throw new Error(
    "The model could not synthesize chunk evidence within the configured limit.",
  );
}

function evidenceSource(evidence) {
  const primary = evidence.filter((item) => item.source_role === "primary");
  const context = evidence.filter(
    (item) => item.source_role === "context-only",
  );
  return `<primary-release-evidence>\n${JSON.stringify(primary)}\n</primary-release-evidence>\n<context-only-release-evidence>\n${JSON.stringify(context)}\n</context-only-release-evidence>`;
}

export async function generateReleaseNotes(client, comparison, options) {
  const audience = releaseNoteAudience(
    options.audience || DEFAULT_RELEASE_NOTE_AUDIENCE,
  );
  const policies = releasePolicies(audience);
  const context = releaseContext({ ...options, audience });
  const chunks = comparisonChunks(comparison, options.maxChunk, audience);
  let source;

  if (audience === "maintainer" && chunks.length === 1) {
    source = `<repository-comparison>\n${chunks[0].content}\n</repository-comparison>`;
  } else {
    const evidence = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      const response = validateEvidence(
        await client.complete([
          { role: "system", content: policies.evidence },
          {
            role: "user",
            content: `Context: ${context}\nChunk ${index + 1} of ${chunks.length}; source role: ${chunk.role}.\n<repository-comparison>\n${chunk.content}\n</repository-comparison>`,
          },
        ]),
      );
      evidence.push(
        ...response.evidence.map((item) => ({
          ...item,
          source_role: chunk.role,
        })),
      );
    }

    if (evidence.length === 0) {
      return { hasReleaseChanges: false, notes: "" };
    }
    const reduced = await reduceEvidence(
      client,
      evidence,
      options.maxChunk,
      policies.reduce,
    );
    if (audience !== "maintainer") {
      if (!reduced.some((item) => item.source_role === "primary")) {
        return { hasReleaseChanges: false, notes: "" };
      }
      const filtered = validateEvidence(
        await client.complete([
          { role: "system", content: policies.filter },
          {
            role: "user",
            content: evidenceSource(reduced),
          },
        ]),
        { requireSourceRole: true },
      ).evidence;
      if (filtered.some((item) => item.source_role !== "primary")) {
        throw new Error(
          "The model returned context-only evidence as a qualifying change.",
        );
      }
      if (filtered.length === 0) {
        return { hasReleaseChanges: false, notes: "" };
      }
      source = evidenceSource(filtered);
    } else {
      source = evidenceSource(reduced);
    }
  }

  const response = await client.complete([
    { role: "system", content: policies.release },
    { role: "user", content: `Release context: ${context}\n${source}` },
  ]);
  return validateReleaseNotes(response);
}
