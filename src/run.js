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

function releaseContext(core, env) {
  if (env.GITHUB_EVENT_NAME === "push") {
    if (env.GITHUB_REF_TYPE !== "tag") {
      throw new Error("Create Release Action runs only for tag push events.");
    }
    if (!env.GITHUB_REF_NAME || !env.GITHUB_SHA || !env.GITHUB_WORKSPACE) {
      throw new Error("GitHub tag context is incomplete.");
    }
    return {
      regenerate: false,
      tag: env.GITHUB_REF_NAME,
      sha: env.GITHUB_SHA,
      workspace: env.GITHUB_WORKSPACE,
    };
  }

  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    const tag = core.getInput("release-tag").trim();
    if (!tag) {
      throw new Error(
        "release-tag is required for workflow_dispatch regeneration runs.",
      );
    }
    if (!env.GITHUB_WORKSPACE) {
      throw new Error("GitHub workflow_dispatch context is incomplete.");
    }
    return {
      regenerate: true,
      tag,
      sha: null,
      workspace: env.GITHUB_WORKSPACE,
    };
  }

  throw new Error(
    "Create Release Action runs only for tag push or workflow_dispatch events.",
  );
}

function regenerationRelease(releases, tag) {
  const matches = releases.filter((release) => release.tag_name === tag);
  const published = matches.filter((release) => !release.draft);
  if (!published.length) {
    throw new Error(
      `No published release exists for ${tag}; nothing was changed.`,
    );
  }
  if (matches.length !== 1) {
    throw new Error(
      `Release tag ${tag} resolves ambiguously to ${matches.length} releases; nothing was changed.`,
    );
  }
  return published[0];
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
  const context = releaseContext(core, env);
  const version = parseSemVer(context.tag);
  const audience = releaseNoteAudience(
    core.getInput("release-notes-audience", { required: true }),
  );
  const token = core.getInput("github-token", { required: true });
  const apiKey = core.getInput("api-key");
  core.setSecret(token);
  if (apiKey) core.setSecret(apiKey);

  const github =
    dependencies.githubService ||
    new GitHubService(
      githubModule.getOctokit(token),
      githubModule.context.repo.owner,
      githubModule.context.repo.repo,
    );
  const releases = await github.listReleases();
  let existing;
  if (context.regenerate) {
    existing = regenerationRelease(releases, context.tag);
  } else {
    existing = releases.find((release) => release.tag_name === context.tag);
    if (existing?.draft) {
      throw new Error(
        `A draft release already exists for ${context.tag}; it was left unchanged.`,
      );
    }
    if (existing) {
      setOutputs(core, existing, existing.body || "", "");
      core.info(
        `Release ${context.tag} already exists and was left unchanged.`,
      );
      return existing;
    }
  }

  const git =
    dependencies.gitRepository || new GitRepository(context.workspace);
  let targetCommit;
  if (context.regenerate) {
    try {
      targetCommit = await git.resolveCommit(`refs/tags/${context.tag}`);
    } catch {
      throw new Error(
        `Tag ${context.tag} does not resolve to a commit in the checked-out repository.`,
      );
    }
  } else {
    targetCommit = await git.resolveCommit(context.tag);
  }
  if (!context.regenerate && targetCommit !== context.sha) {
    throw new Error(
      `Tag ${context.tag} does not resolve to GITHUB_SHA ${context.sha}.`,
    );
  }

  const { baseline, reachable } = await selectBaseline(
    releases,
    context.tag,
    targetCommit,
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
    targetCommit,
  );
  const modelOptions = {
    baseUrl: core.getInput("base-url", { required: true }),
    apiKey,
    model: core.getInput("model", { required: true }),
    reasoningEffort: core.getInput("reasoning-effort"),
    requestOptions: requestOptionsInput(core),
    timeoutSeconds: integerInput(core, "timeout", 1),
    fetchImpl,
  };
  const model = dependencies.createModelClient
    ? dependencies.createModelClient(modelOptions)
    : new ChatCompletionsClient(modelOptions);
  const generateNotes = dependencies.generateNotes || generateReleaseNotes;
  const generated = await generateNotes(model, comparison, {
    version,
    baselineTag: baseline?.tag_name || null,
    softFork,
    audience,
    maxChunk: integerInput(core, "max-chunk", 1000),
  });
  if (!generated.hasReleaseChanges) {
    const outcome = context.regenerate
      ? `release ${context.tag} was left unchanged`
      : "no release was created";
    throw new Error(
      `No changes qualified for the ${audience} release-note audience; ${outcome}.`,
    );
  }
  let notes = generated.notes;
  if (softFork) notes = `${softFork.line}\n\n${notes}`;

  if (context.regenerate) {
    const release = await github.updateReleaseBody(existing.id, notes);
    setOutputs(core, release, notes, baseline?.tag_name || "");
    core.info(`Regenerated release notes for ${release.html_url}`);
    return release;
  }

  const resolveReleaseAssets =
    dependencies.resolveReleaseAssets || resolveAssets;
  const assets = await resolveReleaseAssets(core.getInput("files"), globber);
  const prerelease = isPrerelease(version);
  const publishRelease =
    dependencies.publishRelease || publishReleaseTransaction;
  const release = await publishRelease(github, {
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
