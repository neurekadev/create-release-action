import { compareCore, parseSemVer } from "./semver.js";

const UPSTREAM_LINE =
  /^Upstream: \[([^\]]+) release notes\]\((https:\/\/[^\s)]+)\)$/;

function validateRevisionTransition(version, previousRevision) {
  if (!previousRevision) {
    if (version.revision !== 1) {
      throw new Error("The first soft-fork release must use revision 1.");
    }
    return;
  }

  const comparison = compareCore(version, previousRevision.version);
  if (comparison < 0) {
    throw new Error(
      `Upstream version ${version.core} rolls back from ${previousRevision.version.core}.`,
    );
  }
  if (comparison === 0) {
    const expected = previousRevision.version.revision + 1;
    if (version.revision !== expected) {
      throw new Error(
        `The next same-upstream soft-fork version must be ${version.core}+revision.${expected}.`,
      );
    }
  } else if (version.revision !== 1) {
    throw new Error(
      "A new upstream version must reset the soft-fork revision to 1.",
    );
  }
}

function validateHardForkTransition(version, previousRevision) {
  const expectedMajor = previousRevision.version.major + 1;
  const expected = `${expectedMajor}.0.0`;
  if (
    version.prerelease !== null ||
    version.build !== null ||
    version.major !== expectedMajor ||
    version.minor !== 0 ||
    version.patch !== 0
  ) {
    throw new Error(
      `A soft fork becomes a hard fork at the next stable major ${expected}.`,
    );
  }
}

export function analyzeForkHistory(releases) {
  let mode = "standard";
  let previousRevision = null;

  for (const release of [...releases].reverse()) {
    let version;
    try {
      version = parseSemVer(release.tag_name);
    } catch {
      continue;
    }

    if (version.revision !== null) {
      if (mode === "hard") {
        throw new Error(
          "Hard-fork history cannot return to '+revision.N' releases.",
        );
      }
      validateRevisionTransition(version, previousRevision);
      mode = "soft";
      previousRevision = { release, version };
    } else if (mode === "soft") {
      validateHardForkTransition(version, previousRevision);
      mode = "hard";
      previousRevision = null;
    }
  }

  return { mode, previousRevision };
}

export function validateReleaseTransition(version, history) {
  if (version.revision !== null) {
    if (history.mode === "hard") {
      throw new Error(
        "A hard fork uses normal Semantic Version tags and cannot return to '+revision.N'.",
      );
    }
    validateRevisionTransition(version, history.previousRevision);
    return "soft";
  }

  if (history.mode === "soft") {
    validateHardForkTransition(version, history.previousRevision);
    return "hard";
  }
  return history.mode;
}

function priorUpstream(previousRevision, core) {
  if (!previousRevision || previousRevision.version.core !== core) return null;
  const firstLine = previousRevision.release.body
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const match = firstLine ? UPSTREAM_LINE.exec(firstLine) : null;
  if (!match || match[1] !== core) {
    throw new Error(
      `The previous ${core} soft-fork release has no reusable canonical Upstream line.`,
    );
  }
  return match[2];
}

export async function resolveSoftFork(options) {
  const {
    github,
    repository,
    version,
    previousRevision,
    upstreamRepository,
    upstreamTag,
  } = options;
  if (version.revision === null) return null;

  const reused = priorUpstream(previousRevision, version.core);
  if (reused) {
    return {
      upstreamUrl: reused,
      line: `Upstream: [${version.core} release notes](${reused})`,
    };
  }

  const repositoryName =
    upstreamRepository && upstreamRepository !== "auto"
      ? upstreamRepository
      : repository.parent?.full_name;
  if (!repositoryName || !/^[^/]+\/[^/]+$/.test(repositoryName)) {
    throw new Error(
      "Unable to resolve the upstream repository. Set upstream-repository to owner/repository.",
    );
  }
  const [owner, repo] = repositoryName.split("/", 2);
  const candidates =
    upstreamTag && upstreamTag !== "auto"
      ? [upstreamTag]
      : [version.core, `v${version.core}`];

  for (const tag of candidates) {
    const release = await github.findPublishedReleaseByTag(owner, repo, tag);
    if (release) {
      return {
        upstreamUrl: release.html_url,
        line: `Upstream: [${version.core} release notes](${release.html_url})`,
      };
    }
  }
  throw new Error(
    `No published upstream release was found for ${repositoryName} at ${candidates.join(" or ")}.`,
  );
}
