import { describe, it, expect } from 'vitest';
import { assertAllowed, GitPolicyError, renderCommand } from '../server/git.ts';

const checkout = { cwd: 'C:/repo' };
const worktree = { cwd: 'C:/repo/.git/gcp-worktree' };

/**
 * The guarantees users are asked to trust are enforced here, so they're tested
 * directly rather than inferred from behaviour elsewhere.
 */
describe('git policy', () => {
  it('never allows pushing, whatever the flags', () => {
    for (const args of [['push'], ['push', 'origin', 'main'], ['-c', 'x=y', 'push']]) {
      expect(() => assertAllowed(args, { ...checkout, write: true })).toThrow(GitPolicyError);
    }
  });

  it('blocks other remote and history-rewriting subcommands', () => {
    for (const sub of ['pull', 'fetch', 'rebase', 'filter-branch', 'reflog', 'gc']) {
      expect(() => assertAllowed([sub], { ...checkout, write: true }), sub).toThrow(GitPolicyError);
    }
  });

  it('rejects anything not on the allowlist', () => {
    expect(() => assertAllowed(['bisect'], { ...checkout, write: true })).toThrow(/allowlist/);
  });

  it('requires an explicit opt-in for mutating subcommands', () => {
    expect(() => assertAllowed(['cherry-pick', 'abc1234'], worktree)).toThrow(/write: true/);
    expect(() => assertAllowed(['cherry-pick', 'abc1234'], { ...worktree, write: true })).not.toThrow();
  });

  it('allows read-only subcommands without opt-in', () => {
    expect(() => assertAllowed(['log', '--oneline'], checkout)).not.toThrow();
    expect(() => assertAllowed(['cherry', '-v', 'stable', 'feature'], checkout)).not.toThrow();
    expect(() => assertAllowed(['branch', '--list'], checkout)).not.toThrow();
  });

  it('treats a mutating flag on a dual-purpose subcommand as a write', () => {
    expect(() => assertAllowed(['branch', '-d', 'old'], checkout)).toThrow(GitPolicyError);
  });

  it('keeps working-tree commands inside the managed worktree', () => {
    for (const args of [
      ['cherry-pick', 'abc1234'],
      ['merge', 'develop'],
      ['checkout', '--detach', 'stable'],
      ['commit', '-m', 'x'],
      ['add', '-A'],
      ['clean', '-fd'],
    ]) {
      expect(() => assertAllowed(args, { ...checkout, write: true, scratch: true }), args[0]).toThrow(
        /disposable worktree/,
      );
      expect(() => assertAllowed(args, { ...worktree, write: true, scratch: true }), args[0]).not.toThrow();
    }
  });

  it('double-gates reset and clean behind the scratch flag', () => {
    expect(() => assertAllowed(['reset', '--hard', 'HEAD'], { ...worktree, write: true })).toThrow(
      /scratch: true/,
    );
    expect(() =>
      assertAllowed(['reset', '--hard', 'HEAD'], { ...worktree, write: true, scratch: true }),
    ).not.toThrow();
  });

  it('refuses force flags, except -f for git clean', () => {
    expect(() => assertAllowed(['merge', '--force'], { ...worktree, write: true })).toThrow(/--force/);
    expect(() => assertAllowed(['branch', '-D', 'x'], { ...checkout, write: true })).toThrow(/-D/);
    expect(() =>
      assertAllowed(['clean', '-f', '-d'], { ...worktree, write: true, scratch: true }),
    ).not.toThrow();
  });

  it('restricts update-ref to branches and requires a compare-and-swap', () => {
    const opts = { ...checkout, write: true };
    expect(() => assertAllowed(['update-ref', 'refs/tags/v1', 'aaa', 'bbb'], opts)).toThrow(/refs\/heads/);
    expect(() => assertAllowed(['update-ref', '-d', 'refs/heads/x'], opts)).toThrow(/delete/);
    expect(() => assertAllowed(['update-ref', 'refs/heads/x', 'aaa'], opts)).toThrow(/old value/);
    expect(() => assertAllowed(['update-ref', 'refs/heads/x', 'aaa', 'bbb'], opts)).not.toThrow();
  });

  it('renders commands the way a user would type them', () => {
    expect(renderCommand(['cherry-pick', '-x', 'abc1234'])).toBe('git cherry-pick -x abc1234');
    expect(renderCommand(['merge', '-m', 'Merge branch x'])).toBe('git merge -m "Merge branch x"');
  });
});
