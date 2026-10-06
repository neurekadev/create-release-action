import { isPrerelease, parseSemVer } from "./semver.js";

export class GitHubService {
  constructor(octokit, owner, repo) {
    this.octokit = octokit;
    this.owner = owner;
    this.repo = repo;
  }

  async listReleases() {
    return this.octokit.paginate(this.octokit.rest.repos.listReleases, {
      owner: this.owner,
      repo: this.repo,
      per_page: 100,
    });
  }

  async getRepository() {
    const response = await this.octokit.rest.repos.get({
      owner: this.owner,
      repo: this.repo,
    });
    return response.data;
  }

  async findPublishedReleaseByTag(owner, repo, tag) {
    try {
      const response = await this.octokit.rest.repos.getReleaseByTag({
        owner,
        repo,
        tag,
      });
      return response.data.draft ? null : response.data;
    } catch (error) {
      if (error?.status === 404) return null;
      throw error;
    }
  }

  async createDraftRelease(parameters) {
    const response = await this.octokit.rest.repos.createRelease({
      owner: this.owner,
      repo: this.repo,
      tag_name: parameters.tag,
      name: parameters.tag,
      body: parameters.notes,
      draft: true,
      prerelease: parameters.prerelease,
      generate_release_notes: false,
    });
    return response.data;
  }

  async uploadAsset(releaseId, asset) {
    await this.octokit.rest.repos.uploadReleaseAsset({
      owner: this.owner,
      repo: this.repo,
      release_id: releaseId,
      name: asset.name,
      data: asset.data,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": asset.data.length,
      },
    });
  }

  async publishRelease(releaseId, makeLatest) {
    const response = await this.octokit.rest.repos.updateRelease({
      owner: this.owner,
      repo: this.repo,
      release_id: releaseId,
      draft: false,
      make_latest: makeLatest,
    });
    return response.data;
  }

  async updateReleaseBody(releaseId, body) {
    const response = await this.octokit.rest.repos.updateRelease({
      owner: this.owner,
      repo: this.repo,
      release_id: releaseId,
      body,
    });
    return response.data;
  }

  async getRelease(releaseId) {
    const response = await this.octokit.rest.repos.getRelease({
      owner: this.owner,
      repo: this.repo,
      release_id: releaseId,
    });
    return response.data;
  }

  async deleteRelease(releaseId) {
    await this.octokit.rest.repos.deleteRelease({
      owner: this.owner,
      repo: this.repo,
      release_id: releaseId,
    });
  }
}

function parseReleaseVersion(tag) {
  // Earlier releases may predate bare tags, so accept a leading "v".
  try {
    return parseSemVer(tag.replace(/^v(?=\d)/, ""));
  } catch {
    return null;
  }
}

// Build metadata other than a soft-fork revision does not change the
// version, so 3.2.0+build.1 is the same release as 3.2.0.
function sameVersion(left, right) {
  return (
    left.core === right.core &&
    left.prerelease === right.prerelease &&
    left.revision === right.revision
  );
}

function isBaselineCandidate(release, target, stableTarget) {
  const version = parseReleaseVersion(release.tag_name);
  if (!version || (target && sameVersion(version, target))) return false;
  return !stableTarget || (!isPrerelease(version) && !release.prerelease);
}

export async function selectBaseline(
  releases,
  currentTag,
  targetCommit,
  git,
  options = {},
) {
  const stableTarget = options.stable ?? true;
  const target = currentTag ? parseReleaseVersion(currentTag) : null;
  const candidates = releases
    .filter((release) => !release.draft && release.tag_name !== currentTag)
    .sort(
      (left, right) =>
        new Date(right.published_at || right.created_at).getTime() -
        new Date(left.published_at || left.created_at).getTime(),
    );

  const reachable = [];
  for (const release of candidates) {
    if (!(await git.hasCommit(release.tag_name))) continue;
    if (await git.isAncestor(release.tag_name, targetCommit))
      reachable.push(release);
  }
  return {
    baseline:
      reachable.find((release) =>
        isBaselineCandidate(release, target, stableTarget),
      ) || null,
    reachable,
  };
}
