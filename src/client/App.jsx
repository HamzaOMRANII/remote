import { useEffect, useState } from 'react';
import { usePath, go } from './router.js';
import { api } from './api.js';
import Login from './pages/Login.jsx';
import Devices from './pages/Devices.jsx';
import Users from './pages/Users.jsx';
import Connect from './pages/Connect.jsx';
import Account from './pages/Account.jsx';
import Background from './components/Background.jsx';

export default function App() {
  const path = usePath();
  // undefined = still checking session, null = not signed in, object = signed in
  const [me, setMe] = useState(undefined);

  useEffect(() => {
    if (path === '/login' || path === '/connect') return;
    api.me()
      .then((d) => setMe({ username: d.username, role: d.role, twoFactor: d.twoFactor }))
      .catch(() => { setMe(null); go('/login')(); });
  }, [path]);

  if (path === '/login') return <Login />;
  if (path === '/connect') return <Connect />;   // browser agent — device credentials, no human login
  if (me === undefined) return <Background />;   // brief session check
  if (me === null) return <Background />;         // redirecting to /login

  if (path === '/users') {
    if (me.role !== 'admin') { go('/')(); return <Background />; }
    return <Users me={me} />;
  }
  if (path === '/account') return <Account me={me} />;
  return <Devices me={me} />;
}
