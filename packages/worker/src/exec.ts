import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export interface RunResult {
  stdout: string;
  stderr: string;
}

/**
 * Run a command with explicit args (no shell). Throws on non-zero exit, with the
 * stderr attached. Used for all host-side git operations (SPEC §9).
 */
export async function run(
  cmd: string,
  args: string[],
  opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<RunResult> {
  const { stdout, stderr } = await execFileAsync(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout: stdout.toString(), stderr: stderr.toString() };
}
