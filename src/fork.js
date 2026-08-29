import { compareCore, parseSemVer } from "./semver.js";

const UPSTREAM_LINE =
  /^Upstream: \[([^\]]+) release notes\]\((https:\/\/[^\s)]+)\)$/;

export function findPreviousFork(releases) {
  for (const release of releases) {
    try {
      const version = parseSemVer(release.tag_name);
      if (version.forkRevision !== null) return { release, version };
    } catch {
      // Non-SemVer releases do not define the Neureka sequence.
    }
  }
  return null;
}

export function validateForkTransition(
  version,
  previousFork,
  repositoryIsFork,
) {
  if (version.forkRevision === null) {
    if (previousFork || repositoryIsFork) {
      throw new Error(
        "Fork history requires an exact stable '+neureka.N' release version.",
      );
    }
    return;
  }

  if (!previousFork) {
    if (version.forkRevision !== 1) {
      throw new Error(
        "The first Neureka release for an upstream version must use revision 1.",
      );
    }
    return;
  }

  const comparison = compareCore(version, previousFork.version);
  if (comparison < 0) {
    throw new Error(
      `Upstream version ${version.core} rolls back from ${previousFork.version.core}.`,
    );
  }
  if (comparison === 0) {
    const expected = previousFork.version.forkRevision + 1;
    if (version.forkRevision !== expected) {
      throw new Error(
        `The next same-upstream fork version must be ${version.core}+neureka.${expected}.`,
      );
    }
  } else if (version.forkRevision !== 1) {
    throw new Error(
      "A new upstream version must reset the Neureka revision to 1.",
    );
  }
}

function priorUpstream(previousFork, core) {
  if (!previousFork || previousFork.version.core !== core) return null;
  const firstLine = previousFork.release.body
    ?.split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const match = firstLine ? UPSTREAM_LINE.exec(firstLine) : null;
  if (!match || match[1] !== core) {
    throw new Error(
      `The previous ${core} fork release has no reusable canonical Upstream line.`,
    );
  }
  return match[2];
}

export async function resolveFork(options) {
  const {
    github,
    repository,
    version,
    previousFork,
    upstreamRepository,
    upstreamTag,
  } = options;
  if (version.forkRevision === null) return null;

  const reused = priorUpstream(previousFork, version.core);
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
