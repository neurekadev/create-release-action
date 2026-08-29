import {
  EVIDENCE_POLICY,
  REDUCE_POLICY,
  RELEASE_POLICY,
  releaseContext,
} from "./policy.js";

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

export function parseModelJson(content) {
  const trimmed = content.trim();
  const unwrapped = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  let parsed;
  try {
    parsed = JSON.parse(unwrapped);
  } catch {
    throw new Error("The model response was not valid JSON.");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The model response must be a JSON object.");
  }
  return parsed;
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
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.timeoutMilliseconds,
    );
    const headers = { "content-type": "application/json" };
    if (this.apiKey) {
      headers.authorization = `Bearer ${this.apiKey}`;
    }

    const body = {
      model: this.model,
      messages,
      response_format: { type: "json_object" },
      ...this.requestOptions,
      stream: false,
    };
    if (this.reasoningEffort && this.reasoningEffort !== "none") {
      body.reasoning_effort = this.reasoningEffort;
    }
    body.model = this.model;
    body.messages = messages;

    try {
      const response = await this.fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new Error(`The model endpoint returned HTTP ${response.status}.`);
      }
      const payload = await response.json();
      const content = payload?.choices?.[0]?.message?.content;
      if (typeof content === "string") {
        return parseModelJson(content);
      }
      if (Array.isArray(content)) {
        const text = content
          .filter(
            (item) => item?.type === "text" && typeof item.text === "string",
          )
          .map((item) => item.text)
          .join("");
        return parseModelJson(text);
      }
      throw new Error(
        "The model endpoint returned no assistant message content.",
      );
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
}

function validateEvidence(response) {
  if (
    typeof response.has_user_facing_changes !== "boolean" ||
    !Array.isArray(response.evidence)
  ) {
    throw new Error("The model returned an invalid evidence object.");
  }
  return response;
}

export function validateReleaseNotes(response) {
  if (
    typeof response.has_user_facing_changes !== "boolean" ||
    typeof response.notes !== "string"
  ) {
    throw new Error("The model returned an invalid release-note object.");
  }
  if (!response.has_user_facing_changes) {
    throw new Error(
      "No user-facing changes were found; no release was created.",
    );
  }

  const notes = response.notes.trim();
  const sections = [
    "Added",
    "Changed",
    "Deprecated",
    "Removed",
    "Fixed",
    "Security",
  ];
  let lastSection = -1;
  let bullets = 0;
  for (const line of notes.split("\n")) {
    if (!line.trim()) continue;
    if (line.startsWith("### ")) {
      const index = sections.indexOf(line.slice(4).trim());
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
      "The model reported user-facing changes without any release-note bullets.",
    );
  }
  return notes;
}

async function reduceEvidence(client, evidence, maxChunk) {
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
            { role: "system", content: REDUCE_POLICY },
            {
              role: "user",
              content: `<release-evidence>\n${chunk}\n</release-evidence>`,
            },
          ]),
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

export async function generateReleaseNotes(client, comparison, options) {
  const context = releaseContext(
    options.version,
    options.baselineTag,
    options.softFork,
  );
  const chunks = splitWithoutLoss(comparison, options.maxChunk);
  let source;

  if (chunks.length === 1) {
    source = `<repository-comparison>\n${chunks[0]}\n</repository-comparison>`;
  } else {
    const evidence = [];
    for (let index = 0; index < chunks.length; index += 1) {
      const response = validateEvidence(
        await client.complete([
          { role: "system", content: EVIDENCE_POLICY },
          {
            role: "user",
            content: `Context: ${context}\nChunk ${index + 1} of ${chunks.length}:\n<repository-comparison>\n${chunks[index]}\n</repository-comparison>`,
          },
        ]),
      );
      evidence.push(...response.evidence);
    }
    const reduced = await reduceEvidence(client, evidence, options.maxChunk);
    source = `<release-evidence>\n${JSON.stringify(reduced)}\n</release-evidence>`;
  }

  const response = await client.complete([
    { role: "system", content: RELEASE_POLICY },
    { role: "user", content: `Release context: ${context}\n${source}` },
  ]);
  return validateReleaseNotes(response);
}
