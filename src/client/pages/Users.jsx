import { useEffect, useState } from 'react';
import Background from '../components/Background.jsx';
import TopBar from '../components/TopBar.jsx';
import { api } from '../api.js';

function fmtDate(ts) {
  try { return new Date(ts).toISOString().slice(0, 10); } catch { return '—'; }
}

function CreateForm({ onCreated }) {
  const [u, setU] = useState({ username: '', password: '', role: 'user' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      await api.createUser(u);
      setU({ username: '', password: '', role: 'user' });
      onCreated();
    } catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="panel form-card">
      <h2>New user</h2>
      <form onSubmit={submit}>
        <div className="row">
          <label className="field"><span>Username</span>
            <input type="text" autoCapitalize="none" autoCorrect="off" value={u.username}
              onChange={(e) => setU({ ...u, username: e.target.value })} /></label>
          <label className="field"><span>Password</span>
            <input type="password" value={u.password}
              onChange={(e) => setU({ ...u, password: e.target.value })} /></label>
          <label className="field"><span>Role</span>
            <select value={u.role} onChange={(e) => setU({ ...u, role: e.target.value })}>
              <option value="user">user</option>
              <option value="admin">admin</option>
            </select></label>
        </div>
        <div className="save-row">
          <button type="submit" disabled={busy}>{busy ? 'Creating…' : 'Create user'}</button>
          {err && <span className="login-err" style={{ minHeight: 0 }}>{err}</span>}
        </div>
      </form>
    </section>
  );
}

function Row({ user, me, onChanged }) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState(user.role);
  const [pw, setPw] = useState('');
  const [confirmDel, setConfirmDel] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const isSelf = me && me.username.toLowerCase() === user.username.toLowerCase();

  async function save() {
    setBusy(true); setErr('');
    try {
      const patch = {};
      if (role !== user.role) patch.role = role;
      if (pw) patch.password = pw;
      if (Object.keys(patch).length) await api.updateUser(user.id, patch);
      setEditing(false); setPw(''); onChanged();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function resetTwoFactor() {
    setBusy(true); setErr('');
    try { await api.updateUser(user.id, { resetTwoFactor: true }); setEditing(false); onChanged(); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function del() {
    setBusy(true); setErr('');
    try { await api.deleteUser(user.id); onChanged(); }
    catch (e) { setErr(e.message); setConfirmDel(false); }
    finally { setBusy(false); }
  }

  return (
    <>
      <tr>
        <td><span className="mono">{user.username}</span>{isSelf && <span className="ctl-pin">you</span>}</td>
        <td>
          {editing
            ? <select value={role} onChange={(e) => setRole(e.target.value)}>
                <option value="user">user</option><option value="admin">admin</option></select>
            : <span className={`status ${user.role === 'admin' ? 'status-live' : ''}`}>{user.role}</span>}
        </td>
        <td><span className={`status ${user.twoFactor ? 'status-live' : 'status-planned'}`}>{user.twoFactor ? 'on' : 'off'}</span></td>
        <td className="mono">{fmtDate(user.createdAt)}</td>
        <td className="num">
          {editing ? (
            <div className="action-btns" style={{ justifyContent: 'flex-end' }}>
              <button className="secondary" disabled={busy} onClick={save}>{busy ? '…' : 'Save'}</button>
              <button className="secondary" disabled={busy} onClick={() => { setEditing(false); setRole(user.role); setPw(''); setErr(''); }}>Cancel</button>
            </div>
          ) : confirmDel ? (
            <div className="action-btns" style={{ justifyContent: 'flex-end' }}>
              <button className="secondary" style={{ color: 'var(--crit)' }} disabled={busy} onClick={del}>{busy ? '…' : 'Confirm delete'}</button>
              <button className="secondary" disabled={busy} onClick={() => setConfirmDel(false)}>Cancel</button>
            </div>
          ) : (
            <div className="action-btns" style={{ justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setEditing(true)}>Edit</button>
              <button className="secondary" disabled={isSelf} title={isSelf ? "You can't delete yourself" : ''} onClick={() => setConfirmDel(true)}>Delete</button>
            </div>
          )}
        </td>
      </tr>
      {editing && (
        <tr>
          <td colSpan={5}>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <label className="field" style={{ margin: 0, maxWidth: 320, flex: 1 }}>
                <span>Reset password (leave blank to keep)</span>
                <input type="password" value={pw} onChange={(e) => setPw(e.target.value)} placeholder="New password" />
              </label>
              {user.twoFactor && !isSelf && (
                <button className="secondary" disabled={busy} onClick={resetTwoFactor}
                  title="For a user who lost their phone and recovery codes">Reset 2FA</button>
              )}
            </div>
          </td>
        </tr>
      )}
      {err && <tr><td colSpan={5}><span className="login-err" style={{ minHeight: 0 }}>{err}</span></td></tr>}
    </>
  );
}

export default function Users({ me }) {
  const [users, setUsers] = useState(null);
  const [err, setErr] = useState('');

  function load() {
    api.listUsers().then((d) => setUsers(d.users)).catch((e) => setErr(e.message));
  }
  useEffect(load, []);

  return (
    <>
      <Background />
      <TopBar me={me} />
      <main className="wrap">
        <div>
          <h1 style={{ fontFamily: 'var(--font-mark)', fontSize: 24, margin: 0 }}>
            Users {users && <span className="h2-sub muted">{users.length}</span>}
          </h1>
          <p className="rem-sub" style={{ marginTop: 6 }}>Who can sign in and control your devices.</p>
        </div>

        <CreateForm onCreated={load} />

        <section className="panel">
          <h2>Accounts</h2>
          {err && <p className="login-err" style={{ minHeight: 0 }}>{err}</p>}
          {!users ? <p className="muted">Loading…</p> : (
            <table className="t">
              <thead><tr><th>Username</th><th>Role</th><th>2FA</th><th>Created</th><th className="num">Actions</th></tr></thead>
              <tbody>
                {users.map((u) => <Row key={u.id} user={u} me={me} onChanged={load} />)}
              </tbody>
            </table>
          )}
        </section>
      </main>
    </>
  );
}
