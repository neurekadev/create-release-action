import * as core from "@actions/core";
import * as github from "@actions/github";
import * as glob from "@actions/glob";
import { runAction } from "./run.js";

try {
  await runAction({ core, githubModule: github, globber: glob });
} catch (error) {
  core.setFailed(error instanceof Error ? error.message : String(error));
}
