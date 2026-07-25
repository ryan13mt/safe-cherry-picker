import type { GroupState, ReleaseStatus } from '../../shared/types.ts';

/**
 * Status is never conveyed by colour alone — every state carries a distinct
 * glyph and an explicit label, so the matrix stays readable regardless of colour
 * vision.
 */

export interface StatusLook {
  glyph: string;
  label: string;
  tone: 'released' | 'traced' | 'likely' | 'pending' | 'partial';
  title: string;
}

export function statusLook(status: ReleaseStatus | undefined): StatusLook {
  if (!status) return { glyph: '·', label: 'unknown', tone: 'pending', title: 'No data' };

  switch (status.method) {
    case 'merged':
      return {
        glyph: '✔',
        label: 'merged',
        tone: 'released',
        title: 'The commit itself is an ancestor of this branch. Exact.',
      };
    case 'traced':
      return {
        glyph: '✔ˣ',
        label: 'picked',
        tone: 'traced',
        title:
          status.note ??
          'Cherry-picked with -x; the target commit names this one explicitly. Exact.',
      };
    case 'patch-id':
      return {
        glyph: '🍒',
        label: 'picked',
        tone: 'traced',
        title:
          'An identical patch exists on the target (git cherry / patch-id). High confidence, ' +
          'though a pick that resolved conflicts could still be missed.',
      };
    case 'squashed':
      return {
        glyph: '~?',
        label: 'likely',
        tone: 'likely',
        title: status.note ?? 'Subject found in a squash commit body. Low confidence.',
      };
    case 'subject':
      return {
        glyph: '~?',
        label: 'likely',
        tone: 'likely',
        title: status.note ?? 'A commit with the same subject exists, but the patch differs.',
      };
    default:
      return {
        glyph: '○',
        label: 'pending',
        tone: 'pending',
        title: 'Not found on this branch by any method.',
      };
  }
}

export function groupStateLook(state: GroupState): StatusLook {
  switch (state) {
    case 'released':
      return { glyph: '✔', label: 'released', tone: 'released', title: 'Every commit is on this branch.' };
    case 'partial':
      return {
        glyph: '⚠',
        label: 'partial',
        tone: 'partial',
        title:
          'Some commits are on this branch and some are not. A half-shipped ticket is a latent bug.',
      };
    case 'likely':
      return {
        glyph: '~?',
        label: 'likely',
        tone: 'likely',
        title: 'Only heuristic evidence (squash or subject match) backs this ticket.',
      };
    default:
      return { glyph: '○', label: 'pending', tone: 'pending', title: 'Nothing from this ticket has shipped.' };
  }
}

/**
 * Categorical palette for ticket tinting. Chosen to stay distinguishable on the
 * dark background; the ticket id is always shown alongside, so colour is a
 * secondary cue rather than the only one.
 */
const TICKET_COLOURS = [
  '#7aa2f7',
  '#bb9af7',
  '#7dcfff',
  '#9ece6a',
  '#e0af68',
  '#f7768e',
  '#73daca',
  '#c0caf5',
  '#ff9e64',
  '#b4f9f8',
];

export function ticketColour(ticket: string | null): string {
  if (!ticket) return '#6b7280';
  let hash = 0;
  for (let i = 0; i < ticket.length; i++) hash = (hash * 31 + ticket.charCodeAt(i)) >>> 0;
  return TICKET_COLOURS[hash % TICKET_COLOURS.length];
}
