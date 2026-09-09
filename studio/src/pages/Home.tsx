import { useState } from 'react';
import SpinePage from '../components/Spine';
import { NO_AUTOFILL } from '../lib/fields';
import { platformInfo } from '../lib/platform';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

const STRIPES = [
  { text: 'Record every angle', bg: '#1F6FE5', fg: '#fff', width: '100%' },
  { text: 'Cut live with 1 2 3', bg: '#FFC61A', fg: '#111', width: '92%' },
  { text: 'Fix cuts afterwards', bg: '#FF3B2F', fg: '#fff', width: '84%' },
  { text: 'Render 4:5, 9:16, 16:9', bg: '#6F3FB8', fg: '#fff', width: '76%' },
  { text: 'Footage stays home', bg: '#22B8E0', fg: '#111', width: '68%' },
];

// The front door of camerasoup.com. Says who does what, works out which
// role this device can play, and offers exactly that.
export default function Home({ notice }: { notice?: string }) {
  const platform = platformInfo();
  const [code, setCode] = useState('');
  const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  const join = () => {
    if (clean.length >= 4) location.href = `/j/${clean}`;
  };

  return (
    <SpinePage>
      {notice && <div className="edged notice">{notice}</div>}
      <div className="home-grid">
        <div className="home-col">
          <span className="meta">A multicam studio in your browser</span>
          <h1>Your Mac records. Your iPhones and iPads are the cameras.</h1>
          <p className="lede">
            Nothing gets installed, and the footage never leaves your WiFi.
          </p>
          <div className="roles">
            <div className="role">
              <b>Mac with Chrome</b>
              <span>Runs the show and keeps the footage.</span>
            </div>
            <div className="role">
              <b>iPhone, iPad, Android</b>
              <span>Each one is a camera. Scan the code, name the angle, done.</span>
            </div>
            <div className="role">
              <b>iPad as remote</b>
              <span>Press REC from across the room.</span>
            </div>
          </div>

          {platform.canRecord ? (
            <div className="actions-row">
              <button className="pill solid" onClick={() => (location.href = '/studio')}>
                Start the studio
              </button>
              <button className="pill outline" onClick={() => (location.href = '/check')}>
                Check my network · 10 s
              </button>
              <input
                className="code-input"
                {...NO_AUTOFILL}
                name="join-code"
                value={code}
                placeholder="ABC123"
                aria-label="Join code from the computer"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                onChange={(e) => setCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') join();
                }}
              />
            </div>
          ) : (
            <div className="actions-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
              <p className="lede" style={{ fontSize: 17 }}>
                {platform.desktop
                  ? 'Open this page in Chrome, Edge, Brave or Arc to record. Any browser can still join as a camera.'
                  : `${cap(platform.label)} is a camera. Open camerasoup.com on the computer first, then scan its code or type it here.`}
              </p>
              <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                <input
                  className="code-input"
                  {...NO_AUTOFILL}
                  name="join-code"
                  value={code}
                  placeholder="ABC123"
                  aria-label="Join code from the computer"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  onChange={(e) => setCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') join();
                  }}
                />
                <button className="pill solid" disabled={clean.length < 4} onClick={join}>
                  Join as a camera
                </button>
              </div>
            </div>
          )}
        </div>

        <div className="stripes">
          {STRIPES.map((s, i) => (
            <div
              key={s.text}
              className="stripe"
              style={{
                background: s.bg,
                color: s.fg,
                width: s.width,
                animationDelay: `${i * 80}ms`,
              }}
            >
              {s.text}
            </div>
          ))}
        </div>
      </div>
    </SpinePage>
  );
}
