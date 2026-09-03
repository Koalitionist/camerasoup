import Camera from './pages/Camera';
import Check from './pages/Check';
import Edit from './pages/Edit';
import Join from './pages/Join';
import Producer from './pages/Producer';

export default function App() {
  const path = window.location.pathname;
  if (path.startsWith('/check')) return <Check />;
  if (path.startsWith('/j/')) return <Join />;
  if (path.startsWith('/camera')) return <Camera />;
  if (path.startsWith('/edit')) return <Edit />;
  return <Producer />;
}
