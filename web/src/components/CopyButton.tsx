import { useState } from 'react';

/**
 * Copies text and says so briefly. The clipboard API needs a secure context —
 * localhost counts — and can still be refused, so a failure is shown rather
 * than silently doing nothing.
 */
export function CopyButton({
  text,
  label = 'Copy',
  title,
  className = 'ghost small',
}: {
  text: string;
  label?: string;
  title?: string;
  className?: string;
}) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
    } catch {
      setState('failed');
    }
    setTimeout(() => setState('idle'), 1600);
  };

  return (
    <button className={className} onClick={copy} title={title} type="button">
      {state === 'copied' ? '✓ Copied' : state === 'failed' ? 'Copy blocked' : label}
    </button>
  );
}
