import { isHosted, platformInfo } from './lib/platform';
import Camera from './pages/Camera';
import Check from './pages/Check';
import Edit from './pages/Edit';
import Home from './pages/Home';
import Join from './pages/Join';
import Producer from './pages/Producer';

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith('/j/')) return <Join />;
  if (path.startsWith('/check')) {
    // The check runs where the recording will: on a desktop. A phone or
    // iPad that lands here was meant to scan, not host.
    return platformInfo().desktop ? (
      <Check />
    ) : (
      <Home notice="The check runs on the Mac that will record. On this device, scan the Mac’s code or type it below." />
    );
  }
  if (isHosted()) {
    // The website has the front door and the check; the studio pages still
    // live on the local server until they are ported.
    return (
      <Home notice={path !== '/' ? 'That page isn’t on the website yet. Start with the check on your Mac.' : undefined} />
    );
  }
  if (path.startsWith('/camera')) return <Camera />;
  if (path.startsWith('/edit')) return <Edit />;
  return <Producer />;
}
