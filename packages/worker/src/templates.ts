import { readFileSync } from "node:fs";
import { join } from "node:path";
import Handlebars from "handlebars";
import type { JobMode } from "@kotx/shared";

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

export interface TaskContext {
  repoFullName: string;
  subjectType: string;
  subjectNumber: number;
  branchName: string;
  title: string;
  body: string;
  comments?: Array<{ author: string; location?: string; body: string }>;
  mergeConflicts?: string[];
}

const FILE_BY_MODE: Record<JobMode, string> = {
  implement: "implement.md.hbs",
  review: "review.md.hbs",
};

export function renderTaskMd(mode: JobMode, ctx: TaskContext): string {
  return template(FILE_BY_MODE[mode])(ctx);
}
