import { spawn, spawnSync } from 'node:child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentName } from './types.js';

/** Limit beyond which we switch to a temp-file launch. */
const ARG_INLINE_LIMIT = 8000;

export interface LaunchResult {
  /** Exit code of the child process. */
  code: number;
  /** Final argv used (for debugging / inspect). */
  argv: string[];
  /** Path to the temp file used, if any (cleaned up after the child exits). */
  tempFile: string | null;
}

export interface LaunchOptions {
  agent: AgentName;
  prompt: string;
  /** Override binary path (defaults to PATH lookup). */
  binary?: string;
  /** Additional CLI args to forward, placed before the prompt. */
  extraArgs?: string[];
}

/** Returns true if the named binary is on PATH. */
export function hasBinary(name: string): boolean {
  const res = spawnSync(
    process.platform === 'win32' ? 'where' : 'command',
    process.platform === 'win32' ? [name] : ['-v', name],
    {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      shell: process.platform === 'win32',
    }
  );
  return res.status === 0 && (res.stdout?.trim().length ?? 0) > 0;
}

/**
 * Launch the target agent with the handoff prompt as its initial input.
 *
 * For short prompts we pass the prompt as a positional argv item, which is the
 * native form for both `claude` and `codex`. For long prompts we write the
 * handoff to a 0600 temp file in a per-invocation 0700 directory and pass a
 * short reference prompt instead — that way we never blow past the OS argv
 * limit and never leak the handoff via process listings.
 */
export function launchAgentAsync(opts: LaunchOptions): Promise<LaunchResult> {
  const binary = opts.binary ?? opts.agent;
  let tempFile: string | null = null;
  let argv: string[];

  if (opts.prompt.length > ARG_INLINE_LIMIT) {
    const dir = mkdtempSync(join(tmpdir(), 'context-relay-'));
    tempFile = join(dir, 'handoff.md');
    writeFileSync(tempFile, opts.prompt, { encoding: 'utf8', mode: 0o600 });
    const refPrompt =
      `Read the handoff context file at "${tempFile}" and continue the prior session ` +
      `(it was produced by context-relay). After reading, briefly confirm what you ` +
      `understand the next action to be, then proceed cautiously.`;
    argv = [...(opts.extraArgs ?? []), refPrompt];
  } else {
    argv = [...(opts.extraArgs ?? []), opts.prompt];
  }

  return new Promise<LaunchResult>((resolve) => {
    const child = spawn(binary, argv, {
      stdio: 'inherit',
      shell: false,
    });

    const cleanup = () => {
      if (tempFile) {
        try {
          unlinkSync(tempFile);
        } catch {
          // ignore — file may already be gone
        }
      }
    };

    child.on('exit', (code) => {
      cleanup();
      resolve({ code: code ?? 0, argv, tempFile });
    });
    child.on('error', (err) => {
      cleanup();
      process.stderr.write(`context-relay: failed to launch \`${binary}\`: ${err.message}\n`);
      resolve({ code: 127, argv, tempFile });
    });
  });
}
