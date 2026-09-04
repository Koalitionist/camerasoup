import type { ReactNode } from 'react';

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
        <div className="wordmark">camerasoup</div>
      </div>
      <div className="spine-body">{children}</div>
    </div>
  );
}
