import { usePath } from './router.js';
import Login from './pages/Login.jsx';
import Devices from './pages/Devices.jsx';

export default function App() {
  const path = usePath();
  if (path === '/login') return <Login />;
  return <Devices />;
}
