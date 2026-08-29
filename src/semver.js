const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const REVISION_PATTERN = /^revision\.([1-9]\d*)$/;

export function parseSemVer(value) {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Tag '${value}' is not a complete bare Semantic Version.`);
  }

  const [, major, minor, patch, prerelease, build] = match;
  const revisionMatch = build ? REVISION_PATTERN.exec(build) : null;
  const revisionLooking =
    build === "revision" || build?.startsWith("revision.");
  if (revisionLooking && (prerelease || !revisionMatch)) {
    throw new Error(
      "Revision releases must be stable and use exactly '+revision.N' with a positive revision without leading zeros.",
    );
  }

  return {
    raw: value.trim(),
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    core: `${major}.${minor}.${patch}`,
    prerelease: prerelease || null,
    build: build || null,
    revision: revisionMatch ? Number(revisionMatch[1]) : null,
  };
}

export function compareCore(left, right) {
  for (const field of ["major", "minor", "patch"]) {
    if (left[field] !== right[field]) {
      return left[field] > right[field] ? 1 : -1;
    }
  }
  return 0;
}

export function isPrerelease(version) {
  return version.prerelease !== null;
}
