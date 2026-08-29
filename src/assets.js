import { basename } from "node:path";
import { readFile, stat } from "node:fs/promises";

export async function resolveAssets(patterns, globber) {
  const requested = patterns
    .split("\n")
    .map((pattern) => pattern.trim())
    .filter(Boolean);
  if (requested.length === 0) return [];

  const paths = new Set();
  for (const pattern of requested) {
    const glob = await globber.create(pattern, {
      followSymbolicLinks: false,
      implicitDescendants: false,
      matchDirectories: false,
    });
    const matches = await glob.glob();
    if (matches.length === 0) {
      throw new Error(`Release asset pattern '${pattern}' matched no files.`);
    }
    for (const path of matches) paths.add(path);
  }

  const assets = [];
  const names = new Set();
  for (const path of paths) {
    if (!(await stat(path)).isFile()) continue;
    const name = basename(path);
    if (names.has(name)) {
      throw new Error(
        `More than one release asset resolves to the filename '${name}'.`,
      );
    }
    names.add(name);
    assets.push({ name, data: await readFile(path) });
  }
  if (assets.length === 0)
    throw new Error("Release asset patterns matched no regular files.");
  return assets;
}
