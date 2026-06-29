import type { AgentCommand, Intent, TaskKind } from "./types.js";

export const LABELS = {
  ready: "agent:ready",
  review: "agent:review",
  ignore: "agent:ignore",
} as const;

const COMMAND_RE = /^\/agent\s+(run|review|stop|status)\b/;

/** Parse the first non-empty line of a comment body for an /agent command. */
export function parseCommand(body: string): AgentCommand | null {
  const firstLine = body
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!firstLine) return null;
  const m = COMMAND_RE.exec(firstLine);
  return m ? (m[1] as AgentCommand) : null;
}

/** Map a label set to a kind (run vs review). Ignore label handled by caller. */
export function intentFromLabels(labels: string[]): Intent | null {
  if (labels.includes(LABELS.ready))
    return { kind: "implement", command: null, source: "label" };
  if (labels.includes(LABELS.review))
    return { kind: "review", command: null, source: "label" };
  return null;
}

/** The kind implied by a run/review command (null for control commands). */
export function kindFromCommand(cmd: AgentCommand): TaskKind | null {
  if (cmd === "run") return "implement";
  if (cmd === "review") return "review";
  return null;
}

export function hasIgnoreLabel(labels: string[]): boolean {
  return labels.includes(LABELS.ignore);
}
