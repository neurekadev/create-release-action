import { appendFile, writeFile } from "node:fs/promises";
import * as githubModule from "@actions/github";
import { GitRepository } from "./git.js";
import { GitHubService } from "./github.js";
import { ChatCompletionsClient, DEFAULT_MODEL_CONFIGURATION } from "./model.js";
import {
  generateReleaseNotesPreview,
  previewDocument,
  previewFailureDocument,
  previewRepository,
} from "./preview.js";

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function writePreviewOutput(env, document) {
  const output = env.PREVIEW_OUTPUT;
  if (output) await writeFile(output, document, "utf8");
  if (env.GITHUB_STEP_SUMMARY) {
    await appendFile(env.GITHUB_STEP_SUMMARY, document, "utf8");
  }
}

async function main(env = process.env) {
  const audience = requiredEnvironment(env, "RELEASE_NOTES_AUDIENCE");
  const workflowRepository = requiredEnvironment(env, "WORKFLOW_REPOSITORY");
  const targetRepository = previewRepository(
    env.TARGET_REPOSITORY || "",
    workflowRepository,
  );
  const targetWorkspace = requiredEnvironment(env, "TARGET_WORKSPACE");
  const token = requiredEnvironment(env, "GITHUB_TOKEN");
  const apiKey = requiredEnvironment(env, "INFERENCE_API_KEY");
  const [owner, repo] = targetRepository.split("/");
  const octokit = githubModule.getOctokit(token);
  const github = new GitHubService(octokit, owner, repo);
  const git = new GitRepository(targetWorkspace);
  const client = new ChatCompletionsClient({
    baseUrl: DEFAULT_MODEL_CONFIGURATION.baseUrl,
    apiKey,
    model: DEFAULT_MODEL_CONFIGURATION.model,
    reasoningEffort: DEFAULT_MODEL_CONFIGURATION.reasoningEffort,
    requestOptions: {},
    timeoutSeconds: DEFAULT_MODEL_CONFIGURATION.timeoutSeconds,
  });
  const preview = await generateReleaseNotesPreview({
    audience,
    client,
    git,
    github,
    maxChunk: DEFAULT_MODEL_CONFIGURATION.maxChunk,
    targetRepository,
    workflowRepository,
  });
  await writePreviewOutput(env, previewDocument(preview));
  process.stdout.write(
    `Generated ${audience} release-note preview for ${targetRepository}.\n`,
  );
}

try {
  await main();
} catch (error) {
  const audience = process.env.RELEASE_NOTES_AUDIENCE || "unknown";
  const repository =
    process.env.TARGET_REPOSITORY ||
    process.env.WORKFLOW_REPOSITORY ||
    "unknown";
  const document = previewFailureDocument(audience, repository, error);
  try {
    await writePreviewOutput(process.env, document);
  } catch (writeError) {
    process.stderr.write(
      `Could not write preview failure output: ${writeError instanceof Error ? writeError.message : String(writeError)}\n`,
    );
  }
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
