import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export class GitRepository {
  constructor(workspace, execute = execFileAsync) {
    this.workspace = workspace;
    this.execute = execute;
  }

  async run(args, options = {}) {
    const result = await this.execute("git", ["-C", this.workspace, ...args], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 1024,
      ...options,
    });
    return result.stdout;
  }

  async resolveCommit(ref) {
    return (
      await this.run(["rev-parse", "--verify", `${ref}^{commit}`])
    ).trim();
  }

  async hasCommit(ref) {
    try {
      await this.resolveCommit(ref);
      return true;
    } catch {
      return false;
    }
  }

  async isAncestor(base, head) {
    try {
      await this.run(["merge-base", "--is-ancestor", base, head]);
      return true;
    } catch {
      return false;
    }
  }

  async buildComparison(baseTag, targetCommit) {
    const base = baseTag || EMPTY_TREE;
    const range = baseTag ? `${baseTag}..${targetCommit}` : targetCommit;
    const log = await this.run([
      "log",
      "--reverse",
      "--date=iso-strict",
      "--name-status",
      "--find-renames",
      "--format=commit %H%nDate: %ad%nSubject: %s%nBody:%n%b%nFiles:",
      range,
    ]);
    const diff = await this.run([
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--find-renames",
      "--find-copies",
      "--unified=3",
      base,
      targetCommit,
      "--",
      ".",
    ]);

    return [
      `Comparison: ${baseTag || "empty repository"} -> ${targetCommit}`,
      "",
      "=== COMMITS ===",
      log,
      "=== FULL TEXTUAL DIFF ===",
      diff,
    ].join("\n");
  }
}
