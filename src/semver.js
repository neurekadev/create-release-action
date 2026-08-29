const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

const NEUREKA_PATTERN = /^neureka\.([1-9]\d*)$/;

export function parseSemVer(value) {
  const match = SEMVER_PATTERN.exec(value.trim());
  if (!match) {
    throw new Error(`Tag '${value}' is not a complete bare Semantic Version.`);
  }

  const [, major, minor, patch, prerelease, build] = match;
  const neurekaMatch = build ? NEUREKA_PATTERN.exec(build) : null;
  const neurekaLooking = build === "neureka" || build?.startsWith("neureka.");
  if (neurekaLooking && (prerelease || !neurekaMatch)) {
    throw new Error(
      "Neureka versions must be stable and use exactly '+neureka.N' with a positive revision without leading zeros.",
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
    forkRevision: neurekaMatch ? Number(neurekaMatch[1]) : null,
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
