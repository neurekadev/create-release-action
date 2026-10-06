import { resolveAssets } from "./assets.js";
import {
  analyzeForkHistory,
  resolveSoftFork,
  validateReleaseTransition,
} from "./fork.js";
import { GitRepository } from "./git.js";
import { GitHubService, selectBaseline } from "./github.js";
import {
  MODEL_API_FORMATS,
  createModelClient,
  generateReleaseNotes,
  modelApiFormat,
} from "./model.js";
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

function regenerateAllInput(core) {
  const value = core.getInput("regenerate-all").trim().toLowerCase();
  if (value !== "" && value !== "true" && value !== "false") {
    throw new Error("regenerate-all must be true or false.");
  }
  return value === "true";
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
    const all = regenerateAllInput(core);
    if (all && tag) {
      throw new Error(
        "Set either release-tag or regenerate-all, not both; nothing was changed.",
      );
    }
    if (!all && !tag) {
      throw new Error(
        "release-tag is required for workflow_dispatch regeneration runs unless regenerate-all is true.",
      );
    }
    if (!env.GITHUB_WORKSPACE) {
      throw new Error("GitHub workflow_dispatch context is incomplete.");
    }
    return {
      regenerate: true,
      all,
      tag: all ? null : tag,
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

function publishedTagsOldestFirst(releases) {
  const published = releases
    .filter((release) => !release.draft)
    .sort(
      (left, right) =>
        new Date(left.published_at || left.created_at).getTime() -
        new Date(right.published_at || right.created_at).getTime(),
    );
  return [...new Set(published.map((release) => release.tag_name))];
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
  const version = context.all ? null : parseSemVer(context.tag);
  const audience = releaseNoteAudience(
    core.getInput("release-notes-audience", { required: true }),
  );
  const apiFormat = modelApiFormat(
    core.getInput("api-format", { required: true }),
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
  if (context.all) {
    if (!releases.some((release) => !release.draft)) {
      throw new Error("No published release exists; nothing was changed.");
    }
  } else if (context.regenerate) {
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
  let model;
  let repository;
  const generateNotes = dependencies.generateNotes || generateReleaseNotes;

  // Generates notes for one tag, or returns null when no change qualifies.
  async function notesFor(tag, tagVersion, targetCommit) {
    const { baseline, reachable } = await selectBaseline(
      releases,
      tag,
      targetCommit,
      git,
      { stable: !isPrerelease(tagVersion) },
    );
    if (!baseline && reachable.length > 0) {
      core.warning(
        `No reachable ${isPrerelease(tagVersion) ? "" : "stable "}Semantic Version release can be the baseline, so the release notes cover the full history.`,
      );
    }
    const history = analyzeForkHistory(reachable);
    const releaseMode = validateReleaseTransition(tagVersion, history);
    let softFork = null;
    if (releaseMode === "soft") {
      repository ??= await github.getRepository();
      softFork = await resolveSoftFork({
        github,
        repository,
        version: tagVersion,
        previousRevision: history.previousRevision,
        upstreamRepository: core.getInput("upstream-repository"),
        upstreamTag: core.getInput("upstream-tag"),
      });
    }

    const comparison = await git.buildComparison(
      baseline?.tag_name || null,
      targetCommit,
    );
    model ??= (dependencies.createModelClient || createModelClient)({
      apiFormat,
      baseUrl:
        core.getInput("base-url") || MODEL_API_FORMATS[apiFormat].baseUrl,
      apiKey,
      model: core.getInput("model") || MODEL_API_FORMATS[apiFormat].model,
      reasoningEffort: core.getInput("reasoning-effort"),
      requestOptions: requestOptionsInput(core),
      timeoutSeconds: integerInput(core, "timeout", 1),
      fetchImpl,
    });
    const generated = await generateNotes(model, comparison, {
      version: tagVersion,
      baselineTag: baseline?.tag_name || null,
      softFork,
      audience,
      maxChunk: integerInput(core, "max-chunk", 1000),
    });
    if (!generated.hasReleaseChanges) return null;
    let notes = generated.notes;
    if (softFork) notes = `${softFork.line}\n\n${notes}`;
    return { notes, baselineTag: baseline?.tag_name || "" };
  }

  async function resolveReleaseTag(tag) {
    try {
      return await git.resolveCommit(`refs/tags/${tag}`);
    } catch {
      throw new Error(
        `Tag ${tag} does not resolve to a commit in the checked-out repository.`,
      );
    }
  }

  if (context.all) {
    const regenerated = [];
    const skipped = [];
    const failed = [];
    for (const tag of publishedTagsOldestFirst(releases)) {
      core.info(`Regenerating release notes for ${tag}.`);
      try {
        const target = regenerationRelease(releases, tag);
        let tagVersion;
        try {
          tagVersion = parseSemVer(tag);
        } catch (error) {
          skipped.push(tag);
          core.warning(`Skipped ${tag}: ${error.message}`);
          continue;
        }
        const generated = await notesFor(
          tag,
          tagVersion,
          await resolveReleaseTag(tag),
        );
        if (!generated) {
          skipped.push(tag);
          core.warning(
            `Skipped ${tag}: no changes qualified for the ${audience} release-note audience, so its notes were left unchanged.`,
          );
          continue;
        }
        const release = await github.updateReleaseBody(
          target.id,
          generated.notes,
        );
        regenerated.push(release);
        core.info(`Regenerated release notes for ${release.html_url}`);
      } catch (error) {
        failed.push(tag);
        core.warning(
          `Failed ${tag}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const summary = `Regenerated ${regenerated.length} release${regenerated.length === 1 ? "" : "s"}, skipped ${skipped.length}, failed ${failed.length}.`;
    if (failed.length) {
      throw new Error(
        `${summary} Releases that failed were left unchanged: ${failed.join(", ")}.`,
      );
    }
    core.info(summary);
    return regenerated;
  }

  let targetCommit;
  if (context.regenerate) {
    targetCommit = await resolveReleaseTag(context.tag);
  } else {
    targetCommit = await git.resolveCommit(context.tag);
    if (targetCommit !== context.sha) {
      throw new Error(
        `Tag ${context.tag} does not resolve to GITHUB_SHA ${context.sha}.`,
      );
    }
  }

  const generated = await notesFor(context.tag, version, targetCommit);
  if (!generated) {
    const outcome = context.regenerate
      ? `release ${context.tag} was left unchanged`
      : "no release was created";
    throw new Error(
      `No changes qualified for the ${audience} release-note audience; ${outcome}.`,
    );
  }
  const { notes, baselineTag } = generated;

  if (context.regenerate) {
    const release = await github.updateReleaseBody(existing.id, notes);
    setOutputs(core, release, notes, baselineTag);
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
  setOutputs(core, release, notes, baselineTag);
  core.info(`Published ${release.html_url}`);
  return release;
}
