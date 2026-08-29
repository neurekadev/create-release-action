import { selectBaseline } from "./github.js";
import { generateReleaseNotes } from "./model.js";
import { releaseNoteAudience } from "./policy.js";

const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function previewRepository(value, fallback) {
  const repository = value.trim() || fallback.trim();
  if (!REPOSITORY_PATTERN.test(repository)) {
    throw new Error("repository must use the owner/name format.");
  }
  return repository;
}

export async function generateReleaseNotesPreview(options) {
  const audience = releaseNoteAudience(options.audience);
  let repository;
  try {
    repository = await options.github.getRepository();
  } catch (error) {
    if (error?.status === 404) {
      throw new Error(
        `Repository ${options.targetRepository} is unavailable; previews support the workflow repository and public repositories only.`,
      );
    }
    throw error;
  }
  if (
    repository.private &&
    options.targetRepository !== options.workflowRepository
  ) {
    throw new Error(
      "Cross-repository previews support public repositories only.",
    );
  }

  const targetCommit = await options.git.resolveCommit("HEAD");
  const releases = await options.github.listReleases();
  const { baseline } = await selectBaseline(
    releases,
    null,
    targetCommit,
    options.git,
  );
  const baselineTag = baseline?.tag_name || null;
  const comparison = await options.git.buildComparison(
    baselineTag,
    targetCommit,
  );
  const generated = await generateReleaseNotes(options.client, comparison, {
    audience,
    baselineTag,
    maxChunk: options.maxChunk,
    preview: true,
    targetCommit,
  });
  return {
    audience,
    baselineTag,
    targetCommit,
    targetRepository: options.targetRepository,
    ...generated,
  };
}

function audienceTitle(audience) {
  return audience
    .split("-")
    .map((part) => `${part[0].toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function previewDocument(preview) {
  const baseline = preview.baselineTag || "None (first release)";
  const notes = preview.hasReleaseChanges
    ? preview.notes
    : `_No changes qualify for the ${preview.audience} audience._`;
  return `# ${audienceTitle(preview.audience)} Release Notes Preview

- Repository: \`${preview.targetRepository}\`
- Baseline: \`${baseline}\`
- Target: \`${preview.targetCommit}\`

${notes}
`;
}

export function previewFailureDocument(audience, repository, error) {
  const message = error instanceof Error ? error.message : String(error);
  return `# ${audienceTitle(audience)} Release Notes Preview

- Repository: \`${repository}\`
- Status: Failed

${message}
`;
}
