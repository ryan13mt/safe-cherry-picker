import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setConfig } from '../server/config.ts';

/**
 * Builds a throwaway repo one commit at a time.
 *
 * The big shared fixture is right for the classifier, where the interesting
 * thing is a whole realistic history. Edge cases are the opposite: each one
 * needs a tiny repo shaped for exactly that case, and reading the test should
 * tell you what that shape is. Hence a builder rather than another fixture.
 */
export class RepoBuilder {
  readonly path: string;
  private clock = Math.floor(Date.now() / 1000) - 30 * 86400;

  constructor(initialBranch = 'main') {
    this.path = mkdtempSync(path.join(tmpdir(), 'gcp-edge-'));
    this.run(['init', `--initial-branch=${initialBranch}`, '--quiet']);
    this.run(['config', 'user.name', 'Edge Bot']);
    this.run(['config', 'user.email', 'edge@example.invalid']);
    this.run(['config', 'commit.gpgsign', 'false']);
    this.run(['config', 'core.autocrlf', 'false']);
  }

  run(args: string[], env: NodeJS.ProcessEnv = {}): string {
    return execFileSync('git', args, {
      cwd: this.path,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }

  /** Runs a command that is allowed to fail, returning success plus output. */
  tryRun(args: string[]): { ok: boolean; output: string } {
    try {
      return { ok: true, output: this.run(args) };
    } catch (err) {
      const e = err as { stderr?: string; stdout?: string; message: string };
      return { ok: false, output: String(e.stderr ?? e.stdout ?? e.message) };
    }
  }

  write(file: string, contents: string): this {
    const full = path.join(this.path, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents, 'utf8');
    return this;
  }

  /** Writes bytes containing NUL, which is git's own test for "binary". */
  binary(file: string, seed: number): this {
    const buf = Buffer.from([0x00, 0x01, 0x02, seed, 0xff, 0x00, seed, 0x7f]);
    writeFileSync(path.join(this.path, file), buf);
    return this;
  }

  remove(file: string): this {
    unlinkSync(path.join(this.path, file));
    return this;
  }

  /** Who authors subsequent commits, for testing per-ticket attribution. */
  private author = { name: 'Edge Bot', email: 'edge@example.invalid' };

  as(name: string, email = `${name.toLowerCase().replace(/\s+/g, '.')}@example.invalid`): this {
    this.author = { name, email };
    return this;
  }

  commit(message: string): string {
    this.clock += 3600;
    const stamp = `${this.clock} +0000`;
    this.run(['add', '-A']);
    this.run(['commit', '-m', message], {
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
      GIT_AUTHOR_NAME: this.author.name,
      GIT_AUTHOR_EMAIL: this.author.email,
    });
    return this.run(['rev-parse', 'HEAD']);
  }

  /** Commits with an explicit timestamp, for testing clock-skew ordering. */
  commitAt(message: string, epochSeconds: number): string {
    const stamp = `${epochSeconds} +0000`;
    this.run(['add', '-A']);
    this.run(['commit', '-m', message], {
      GIT_AUTHOR_DATE: stamp,
      GIT_COMMITTER_DATE: stamp,
      GIT_AUTHOR_NAME: this.author.name,
      GIT_AUTHOR_EMAIL: this.author.email,
    });
    return this.run(['rev-parse', 'HEAD']);
  }

  branch(name: string, from?: string): this {
    this.run(from ? ['branch', name, from] : ['branch', name]);
    return this;
  }

  checkout(name: string, createFrom?: string): this {
    this.run(createFrom ? ['checkout', '--quiet', '-b', name, createFrom] : ['checkout', '--quiet', name]);
    return this;
  }

  /** An orphan branch shares no history — the unrelated-histories case. */
  orphan(name: string): this {
    this.run(['checkout', '--quiet', '--orphan', name]);
    this.run(['rm', '-rf', '--cached', '.']);
    for (const entry of execFileSync('git', ['ls-files'], { cwd: this.path, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean)) {
      try {
        unlinkSync(path.join(this.path, entry));
      } catch {
        /* already gone */
      }
    }
    return this;
  }

  mergeInto(branch: string, message = `Merge ${branch}`): void {
    this.clock += 3600;
    this.run(['merge', '--no-ff', '--no-edit', '-m', message, branch], {
      GIT_AUTHOR_DATE: `${this.clock} +0000`,
      GIT_COMMITTER_DATE: `${this.clock} +0000`,
    });
  }

  sha(rev: string): string {
    return this.run(['rev-parse', rev]);
  }

  subject(rev: string): string {
    return this.run(['log', '-1', '--format=%s', rev]);
  }

  /** Points the app's config at this repo. */
  use(chain: string[] = ['develop', 'stable', 'prod']): this {
    setConfig({ scanRoot: this.path, chain });
    return this;
  }

  dispose(): void {
    try {
      rmSync(this.path, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      // Windows sometimes holds a worktree handle; a stray temp dir is not
      // worth failing a run over.
    }
  }
}
