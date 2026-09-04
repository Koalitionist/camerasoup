import { isHosted, platformInfo } from './lib/platform';
import Camera from './pages/Camera';
import Check from './pages/Check';
import Edit from './pages/Edit';
import Home from './pages/Home';
import Join from './pages/Join';
import Producer from './pages/Producer';
import Studio from './pages/Studio';

export default function App() {
  const path = window.location.pathname;
  // Everything a phone or tablet does in a session: camera, remote control,
  // or the connection check.
  if (path.startsWith('/j/')) return <Join />;
  if (path.startsWith('/studio') || path.startsWith('/check') || path.startsWith('/edit')) {
    // Recording, editing and the check all belong on the computer that holds
    // the footage.
    if (!platformInfo().desktop) {
      return (
        <Home notice="The studio runs on the computer that records. On this device, scan the computer’s code or type it below." />
      );
    }
    if (path.startsWith('/studio')) return <Studio />;
    return path.startsWith('/edit') ? <Edit /> : <Check />;
  }
  if (isHosted()) {
    return (
      <Home
        notice={
          path !== '/' ? 'That page isn’t on the website yet. Start the studio on your computer.' : undefined
        }
      />
    );
  }
  if (path.startsWith('/camera')) return <Camera />;
  return <Producer />;
}
