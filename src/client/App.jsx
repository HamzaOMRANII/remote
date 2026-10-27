import { useEffect, useState } from 'react';
import { usePath, go } from './router.js';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Devices from './pages/Devices.jsx';
import Users from './pages/Users.jsx';
import Background from './components/Background.jsx';

export default function App() {
  const path = usePath();
  // undefined = still checking session, null = not signed in, object = signed in
  const [me, setMe] = useState(undefined);

  useEffect(() => {
    if (path === '/login') return;
    api.me()
      .then((d) => setMe({ username: d.username, role: d.role }))
      .catch(() => { setMe(null); go('/login')(); });
  }, [path]);

  if (path === '/login') return <Login />;
  if (me === undefined) return <Background />;   // brief session check
  if (me === null) return <Background />;         // redirecting to /login

  if (path === '/users') {
    if (me.role !== 'admin') { go('/')(); return <Background />; }
    return <Users me={me} />;
  }
  return <Devices me={me} />;
}
