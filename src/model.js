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
  "build",
  "coverage",
  "dist",
  "fixtures",
  "node_modules",
  "spec",
  "specs",
  "test",
  "tests",
  "third_party",
  "vendor",
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
  "dockerfile",
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

export const DEFAULT_MODEL_CONFIGURATION = Object.freeze({
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-5.6-luna",
  reasoningEffort: "xhigh",
  maxChunk: 200000,
  timeoutSeconds: 300,
});

export function chatCompletionsUrl(baseUrl) {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) {
    throw new Error("base-url cannot be empty.");
  }
  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
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

  if (parts.some((part) => CONTEXT_ONLY_DIRECTORIES.has(part))) return true;
  if (CONTEXT_ONLY_BASENAMES.has(basename)) return true;
  if (/\.(?:lock|min\.js|map)$/.test(basename)) return true;
  if (/\.(?:test|spec)\.[^.]+$/.test(basename)) return true;
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
    ["parameter", payload?.error?.param],
    ["request", response.headers?.get?.("x-request-id")],
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

export class ChatCompletionsClient {
  constructor(options) {
    this.url = chatCompletionsUrl(options.baseUrl);
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.reasoningEffort = options.reasoningEffort;
    this.requestOptions = options.requestOptions;
    this.timeoutMilliseconds = options.timeoutSeconds * 1000;
    this.fetch = options.fetchImpl || fetch;
  }

  async complete(messages) {
    const headers = { "content-type": "application/json" };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    let requestMessages = messages;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        this.timeoutMilliseconds,
      );
      const body = {
        model: this.model,
        messages: requestMessages,
        response_format: { type: "json_object" },
        ...this.requestOptions,
        stream: false,
      };
      if (this.reasoningEffort && this.reasoningEffort !== "none") {
        body.reasoning_effort = this.reasoningEffort;
      }
      body.model = this.model;
      body.messages = requestMessages;

      try {
        const response = await this.fetch(this.url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw await modelHttpError(response, this.apiKey);
        }
        const payload = await response.json();
        const content = messageText(payload?.choices?.[0]?.message?.content);
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
