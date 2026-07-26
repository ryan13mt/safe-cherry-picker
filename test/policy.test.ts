import { describe, it, expect } from 'vitest';
import { assertAllowed, GitPolicyError, renderCommand, isInsideManagedWorktree } from '../server/git.ts';

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
    for (const sub of ['pull', 'rebase', 'filter-branch', 'reflog', 'gc', 'remote']) {
      expect(() => assertAllowed([sub], { ...checkout, write: true }), sub).toThrow(GitPolicyError);
    }
  });

  it('allows fetch only on request, and never with a refspec', () => {
    // Fetch only moves refs/remotes, so it is permitted — but `git fetch origin
    // main:main` writes a *local* branch, which is why refspecs are refused.
    expect(() => assertAllowed(['fetch', 'origin'], checkout)).toThrow(/network: true/);
    expect(() => assertAllowed(['fetch', '--quiet', 'origin'], { ...checkout, network: true })).not.toThrow();

    expect(() =>
      assertAllowed(['fetch', 'origin', 'main:main'], { ...checkout, network: true }),
    ).toThrow(/refspec/i);
    expect(() =>
      assertAllowed(['fetch', 'origin', '+refs/heads/*:refs/heads/*'], { ...checkout, network: true }),
    ).toThrow(/refspec/i);

    // Unvetted flags are refused rather than assumed harmless.
    expect(() =>
      assertAllowed(['fetch', '--update-head-ok', 'origin'], { ...checkout, network: true }),
    ).toThrow(/not permitted/);

    // And the opt-in unlocks nothing else.
    expect(() => assertAllowed(['push', 'origin'], { ...checkout, write: true, network: true })).toThrow(
      /not permitted/,
    );
    expect(() => assertAllowed(['pull'], { ...checkout, write: true, network: true })).toThrow(
      /not permitted/,
    );
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
    expect(() =>
      assertAllowed(['clean', '-f', '-d'], { ...worktree, write: true, scratch: true }),
    ).not.toThrow();
  });

  it('gates branch -D behind an explicit opt-in', () => {
    // Needed for branches that shipped by cherry-pick, since git's own -d only
    // understands ancestry — but never available by accident.
    expect(() => assertAllowed(['branch', '-D', 'x'], { ...checkout, write: true })).toThrow(/-D/);
    expect(() =>
      assertAllowed(['branch', '-D', 'x'], { ...checkout, write: true, forceDelete: true }),
    ).not.toThrow();
    // The opt-in unlocks nothing else.
    expect(() =>
      assertAllowed(['merge', '--force'], { ...worktree, write: true, forceDelete: true }),
    ).toThrow(/--force/);
    expect(() =>
      assertAllowed(['push', '--force'], { ...checkout, write: true, forceDelete: true }),
    ).toThrow(/not permitted/);
  });

  it('restricts update-ref to branches and requires a compare-and-swap', () => {
    const opts = { ...checkout, write: true };
    expect(() => assertAllowed(['update-ref', 'refs/tags/v1', 'aaa', 'bbb'], opts)).toThrow(/refs\/heads/);
    expect(() => assertAllowed(['update-ref', '-d', 'refs/heads/x'], opts)).toThrow(/delete/);
    expect(() => assertAllowed(['update-ref', 'refs/heads/x', 'aaa'], opts)).toThrow(/old value/);
    expect(() => assertAllowed(['update-ref', 'refs/heads/x', 'aaa', 'bbb'], opts)).not.toThrow();
  });

  it('still finds the ref when a reflog message is supplied', () => {
    // `-m <reason>` sits between the subcommand and the ref, so a positional
    // check would otherwise read "-m" as the ref and wave everything through.
    const opts = { ...checkout, write: true };
    expect(() =>
      assertAllowed(['update-ref', '-m', 'reason', 'refs/heads/x', 'aaa', 'bbb'], opts),
    ).not.toThrow();
    expect(() =>
      assertAllowed(['update-ref', '-m', 'reason', 'refs/tags/v1', 'aaa', 'bbb'], opts),
    ).toThrow(/refs\/heads/);
    expect(() =>
      assertAllowed(['update-ref', '-m', 'reason', 'refs/heads/x', 'aaa'], opts),
    ).toThrow(/old value/);
    // A message that looks like a ref must not be mistaken for one.
    expect(() =>
      assertAllowed(['update-ref', '-m', 'refs/heads/x', 'refs/tags/v1', 'aaa', 'bbb'], opts),
    ).toThrow(/refs\/heads/);
  });

  it('refuses global options that redirect git elsewhere', () => {
    // Without this, `git -C /elsewhere cherry-pick` run from inside the scratch
    // worktree would satisfy the cwd check and then act on another repo.
    for (const args of [
      ['-C', 'C:/other-repo', 'cherry-pick', 'abc1234'],
      ['--git-dir', 'C:/other/.git', 'reset', '--hard'],
      ['--work-tree=C:/other', 'checkout', 'main'],
    ]) {
      expect(() =>
        assertAllowed(args, { ...worktree, write: true, scratch: true }),
        args.join(' '),
      ).toThrow(/redirect/i);
    }
  });

  it('still allows -C after the subcommand, where it means something else', () => {
    // `git commit -C <commit>` reuses a message; banning the characters
    // outright would break it.
    expect(() =>
      assertAllowed(['commit', '-C', 'abc1234'], { ...worktree, write: true }),
    ).not.toThrow();
  });

  it('does not mistake a -c option value for the subcommand', () => {
    expect(() => assertAllowed(['-c', 'core.pager=cat', 'push'], { ...checkout, write: true })).toThrow(
      /not permitted/i,
    );
    expect(() => assertAllowed(['-c', 'core.pager=cat', 'log'], checkout)).not.toThrow();
  });

  it('recognises the managed worktree by position, not just by name', () => {
    expect(isInsideManagedWorktree('C:/repo/.git/gcp-worktree')).toBe(true);
    expect(isInsideManagedWorktree('C:/repo/.git/gcp-worktree/src/deep')).toBe(true);
    // A real checkout that merely happens to be named gcp-worktree must not
    // unlock reset --hard against itself.
    expect(isInsideManagedWorktree('C:/work/gcp-worktree')).toBe(false);
    expect(isInsideManagedWorktree('C:/work/gcp-worktree/app')).toBe(false);
    expect(isInsideManagedWorktree('C:/repo')).toBe(false);
  });

  it('allows rm -f, but only inside the scratch worktree', () => {
    // Resolving a delete/modify conflict needs it; your checkout never does.
    expect(() => assertAllowed(['rm', '-f', '--', 'a.txt'], { ...worktree, write: true })).not.toThrow();
    expect(() => assertAllowed(['rm', '-f', '--', 'a.txt'], { ...checkout, write: true })).toThrow(
      /disposable worktree/,
    );
  });

  it('treats ls-files as a read', () => {
    expect(() => assertAllowed(['ls-files', '-u', '-z'], worktree)).not.toThrow();
  });

  it('renders commands the way a user would type them', () => {
    expect(renderCommand(['cherry-pick', '-x', 'abc1234'])).toBe('git cherry-pick -x abc1234');
    expect(renderCommand(['merge', '-m', 'Merge branch x'])).toBe('git merge -m "Merge branch x"');
  });
});
