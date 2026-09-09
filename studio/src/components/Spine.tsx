import type { ReactNode } from 'react';

const WORDMARK = 'camerasoup';

// The light poster page: a wordmark rotated down the left spine, content on
// the right. Shared by the website, the phone's role picker and every gate.
export default function SpinePage({
  children,
  phone = false,
}: {
  children: ReactNode;
  phone?: boolean;
}) {
  return (
    <div className="spine-page">
      <div className={`spine${phone ? ' phone-spine' : ''}`}>
        {/* One span per letter so they can arrive in reading order. The word
            is on the parent for anything that reads the page aloud, since ten
            separate letters are not a word to a screen reader. */}
        <div className="wordmark" aria-label={WORDMARK}>
          {[...WORDMARK].map((letter, i) => (
            <span key={i} aria-hidden="true" style={{ animationDelay: `${i * 45}ms` }}>
              {letter}
            </span>
          ))}
        </div>
      </div>
      <div className="spine-body">{children}</div>
    </div>
  );
}
