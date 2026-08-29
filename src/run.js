import { resolveAssets } from "./assets.js";
import {
  analyzeForkHistory,
  resolveSoftFork,
  validateReleaseTransition,
} from "./fork.js";
import { GitRepository } from "./git.js";
import { GitHubService, selectBaseline } from "./github.js";
import { ChatCompletionsClient, generateReleaseNotes } from "./model.js";
import { releaseNoteAudience } from "./policy.js";
import { publishReleaseTransaction } from "./release.js";
import { isPrerelease, parseSemVer } from "./semver.js";

function integerInput(core, name, minimum) {
  const raw = core.getInput(name, { required: true });
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer of at least ${minimum}.`);
  }
  return value;
}

function requestOptionsInput(core) {
  let value;
  try {
    value = JSON.parse(core.getInput("request-options") || "{}");
  } catch {
    throw new Error("request-options must be a valid JSON object.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("request-options must be a JSON object.");
  }
  return value;
}

function tagContext(env) {
  if (env.GITHUB_EVENT_NAME !== "push" || env.GITHUB_REF_TYPE !== "tag") {
    throw new Error("Create Release Action runs only for tag push events.");
  }
  if (!env.GITHUB_REF_NAME || !env.GITHUB_SHA || !env.GITHUB_WORKSPACE) {
    throw new Error("GitHub tag context is incomplete.");
  }
  return {
    tag: env.GITHUB_REF_NAME,
    sha: env.GITHUB_SHA,
    workspace: env.GITHUB_WORKSPACE,
  };
}

function setOutputs(core, release, notes, baselineTag) {
  core.setOutput("release-id", String(release.id));
  core.setOutput("release-url", release.html_url);
  core.setOutput("release-notes", notes);
  core.setOutput("baseline-tag", baselineTag || "");
}

export async function runAction(dependencies) {
  const {
    core,
    githubModule,
    globber,
    env = process.env,
    fetchImpl,
  } = dependencies;
  const context = tagContext(env);
  const version = parseSemVer(context.tag);
  const audience = releaseNoteAudience(
    core.getInput("release-notes-audience", { required: true }),
  );
  const token = core.getInput("github-token", { required: true });
  const apiKey = core.getInput("api-key");
  core.setSecret(token);
  if (apiKey) core.setSecret(apiKey);

  const octokit = githubModule.getOctokit(token);
  const github = new GitHubService(
    octokit,
    githubModule.context.repo.owner,
    githubModule.context.repo.repo,
  );
  const releases = await github.listReleases();
  const existing = releases.find((release) => release.tag_name === context.tag);
  if (existing?.draft) {
    throw new Error(
      `A draft release already exists for ${context.tag}; it was left unchanged.`,
    );
  }
  if (existing) {
    setOutputs(core, existing, existing.body || "", "");
    core.info(`Release ${context.tag} already exists and was left unchanged.`);
    return existing;
  }

  const git = new GitRepository(context.workspace);
  const tagCommit = await git.resolveCommit(context.tag);
  if (tagCommit !== context.sha) {
    throw new Error(
      `Tag ${context.tag} does not resolve to GITHUB_SHA ${context.sha}.`,
    );
  }

  const { baseline, reachable } = await selectBaseline(
    releases,
    context.tag,
    context.sha,
    git,
  );
  const history = analyzeForkHistory(reachable);
  const releaseMode = validateReleaseTransition(version, history);
  let softFork = null;
  if (releaseMode === "soft") {
    const repository = await github.getRepository();
    softFork = await resolveSoftFork({
      github,
      repository,
      version,
      previousRevision: history.previousRevision,
      upstreamRepository: core.getInput("upstream-repository"),
      upstreamTag: core.getInput("upstream-tag"),
    });
  }

  const comparison = await git.buildComparison(
    baseline?.tag_name || null,
    context.sha,
  );
  const model = new ChatCompletionsClient({
    baseUrl: core.getInput("base-url", { required: true }),
    apiKey,
    model: core.getInput("model", { required: true }),
    reasoningEffort: core.getInput("reasoning-effort"),
    requestOptions: requestOptionsInput(core),
    timeoutSeconds: integerInput(core, "timeout", 1),
    fetchImpl,
  });
  const generated = await generateReleaseNotes(model, comparison, {
    version,
    baselineTag: baseline?.tag_name || null,
    softFork,
    audience,
    maxChunk: integerInput(core, "max-chunk", 1000),
  });
  if (!generated.hasReleaseChanges) {
    throw new Error(
      `No changes qualified for the ${audience} release-note audience; no release was created.`,
    );
  }
  let notes = generated.notes;
  if (softFork) notes = `${softFork.line}\n\n${notes}`;

  const assets = await resolveAssets(core.getInput("files"), globber);
  const prerelease = isPrerelease(version);
  const release = await publishReleaseTransaction(github, {
    tag: context.tag,
    notes,
    prerelease,
    assets,
    makeLatest: prerelease
      ? "false"
      : version.revision !== null
        ? "true"
        : "legacy",
  });
  setOutputs(core, release, notes, baseline?.tag_name || "");
  core.info(`Published ${release.html_url}`);
  return release;
}
