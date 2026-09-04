import { useState } from 'react';
import { platformInfo } from '../lib/platform';

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

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
    <div className="home-page">
      <header className="check-header">
        <h1>camerasoup</h1>
        <span>a multicam studio in your browser</span>
      </header>

      {notice && <div className="notice">{notice}</div>}

      <p className="lede">
        Your Mac records. Your iPhones and iPads are the cameras. Nothing gets installed, and the
        footage never leaves your WiFi.
      </p>

      <section className="roles">
        <div className="role">
          <b>Mac with Chrome</b>
          <span>
            Runs the show and keeps the footage. A PC with Chrome, Edge, Brave or Arc works too.
          </span>
        </div>
        <div className="role">
          <b>iPhone, iPad, Android</b>
          <span>Each one is a camera. Scan the Mac’s code in Safari or Chrome, name the angle, done.</span>
        </div>
        <div className="role">
          <b>iPad as remote control</b>
          <span>
            Any spare device can be the control room: see every camera and press REC from across
            the room while the Mac keeps recording.
          </span>
        </div>
      </section>

      {platform.canRecord ? (
        <section className="home-action">
          <h2>{cap(platform.label)} can record.</h2>
          <p className="hint">
            Pick a folder for the footage, then add cameras by scanning the code that appears.
          </p>
          <button className="big" onClick={() => (location.href = '/studio')}>
            Start the studio
          </button>
          <button onClick={() => (location.href = '/check')}>
            First check my network (10 seconds)
          </button>
        </section>
      ) : platform.desktop ? (
        <section className="home-action">
          <h2>Open this page in Chrome to record.</h2>
          <p className="hint">
            Safari and Firefox can’t save recordings into a folder yet. Chrome, Edge, Brave or Arc
            can. Any browser can still join as a camera below.
          </p>
        </section>
      ) : (
        <section className="home-action">
          <h2>{cap(platform.label)} is a camera.</h2>
          <p className="hint">
            Recording needs a Mac with Chrome. Open camerasoup.com on the Mac first, then scan its
            code with {platform.label} or type the code here.
          </p>
        </section>
      )}

      <section className="home-join">
        <label htmlFor="join-code">Have a code from the Mac?</label>
        <div className="code-row">
          <input
            id="join-code"
            value={code}
            placeholder="ABC123"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') join();
            }}
          />
          <button disabled={clean.length < 4} onClick={join}>
            Join as a camera
          </button>
        </div>
      </section>

      <p className="hint">Free while it’s being built.</p>
    </div>
  );
}
