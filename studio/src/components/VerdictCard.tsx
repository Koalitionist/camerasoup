import { useState } from 'react';
import type { CheckReport } from '../lib/check';

// The verdict, shown identically on the computer and the phone: a rounded
// panel with a half-pill edge in the state color. Copy gives the full
// report as JSON — the thing to paste into a bug report.
export default function VerdictCard({
  report,
  onAgain,
  againLabel = 'Test again',
}: {
  report: CheckReport;
  onAgain?: () => void;
  againLabel?: string;
}) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(report, null, 2));
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked: nothing to do
    }
  };
  return (
    <section className={`edged verdict ${report.verdict}`}>
      <h2>{report.headline}</h2>
      <ul>
        {report.lines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      {report.path && (
        <div className="numbers">
          <div>
            <b>{report.cameras1080}</b>cameras at 1080p
          </div>
          <div>
            <b>{report.cameras720}</b>cameras at 720p
          </div>
          <div>
            <b>{report.mbps.toFixed(0)}</b>Mbps to the computer
          </div>
          <div>
            <b>{report.rttMs}</b>ms round trip
          </div>
        </div>
      )}
      <div className="actions">
        {onAgain && (
          <button className="pill outline" onClick={onAgain}>
            {againLabel}
          </button>
        )}
        <button className="pill outline" onClick={copy}>
          {copied ? 'Copied' : 'Copy diagnostics'}
        </button>
      </div>
    </section>
  );
}
