import { readFileSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";
import type { DraftFollowUpInput } from "@kotx/shared";

const PROMPTS_DIR = process.env.PROMPTS_DIR ?? join(process.cwd(), "prompts");

const cache = new Map<string, HandlebarsTemplateDelegate>();

function template(name: string): HandlebarsTemplateDelegate {
  let t = cache.get(name);
  if (!t) {
    const src = readFileSync(join(PROMPTS_DIR, name), "utf8");
    t = Handlebars.compile(src, { noEscape: true });
    cache.set(name, t);
  }
  return t;
}

// Which prompt file backs each run. "draft" and "implement" are the two phases of
// a Branch 1 task; "resolve_conflict" and "review" are single-phase.
export type PromptKind = "draft" | "implement" | "resolve_conflict" | "review";

export interface TaskContext {
  repoFullName: string;
  subjectKind: string; // "issue" | "pull request" (human-readable)
  subjectNumber: number;
  branchName: string;
  defaultBranch: string;
  title: string;
  body: string;
  comments?: Array<{ author: string; location?: string; body: string }>;
  mergeConflicts?: string[];
  // draft only: differentiates first-assignment from a follow-up.
  isFollowUp?: boolean;
  // draft follow-up only: prior reviewed TASK.md plus latest triggering input.
  previousTaskBrief?: string;
  followUpInput?: DraftFollowUpInput;
  followUpInputHasBody?: boolean;
  needsFollowUpFallback?: boolean;
  // implement only: the approved TASK.md brief, embedded as the instructions.
  taskBrief?: string;
  // implement (issue-origin execute) only: the agent must also propose a PR
  // (PR_TITLE.md / PR_BODY.md) because no PR exists yet for this work.
  opensPr?: boolean;
  // the repo's PR template, if any, to shape the proposed PR description.
  prTemplate?: string;
  // true when the per-run dev-container (DinD) sidecar is enabled.
  dockerAvailable?: boolean;
}

const FILE_BY_KIND: Record<PromptKind, string> = {
  draft: "draft.md.hbs",
  implement: "implement.md.hbs",
  resolve_conflict: "resolve-conflict.md.hbs",
  review: "review.md.hbs",
};

export function renderPrompt(kind: PromptKind, ctx: TaskContext): string {
  return template(FILE_BY_KIND[kind])(ctx);
}
