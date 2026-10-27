import { useRef, useState } from 'react';

// `scripts` capability: a button per allowlisted script. Running one streams its
// output into the panel and ends with the exit code. Commands live on the device
// (only id + label are advertised).
export default function ScriptRunner({ device, cap, runStream }) {
  const scripts = cap.scripts || [];
  const [running, setRunning] = useState('');
  const [title, setTitle] = useState('');
  const [out, setOut] = useState('');
  const [exit, setExit] = useState(null);
  const outRef = useRef(null);

  async function run(s) {
    setRunning(s.id); setTitle(s.label || s.id); setOut(''); setExit(null);
    try {
      const { done } = runStream(device, 'scripts', 'run', { id: s.id }, (chunk) => {
        setOut((o) => o + chunk);
        requestAnimationFrame(() => { if (outRef.current) outRef.current.scrollTop = outRef.current.scrollHeight; });
      });
      const data = await done;
      setExit(data && typeof data.code === 'number' ? data.code : 0);
    } catch (e) {
      setOut((o) => o + `\n[error] ${e.message}\n`); setExit(-1);
    } finally { setRunning(''); }
  }

  return (
    <div className="cap-block">
      <div className="cap-head">Scripts</div>
      {scripts.length === 0 ? <span className="muted rem-sub">No scripts configured.</span> : (
        <div className="action-btns">
          {scripts.map((s) => (
            <button key={s.id} className="secondary" disabled={!!running}
              onClick={() => run(s)}>{running === s.id ? '…' : (s.label || s.id)}</button>
          ))}
        </div>
      )}
      {(out || running) && (
        <div className={`out ${exit !== null && exit !== 0 ? 'out-err' : ''}`} style={{ marginTop: 12 }}>
          <div className="out-head">
            {title}{running ? ' · running…' : exit !== null ? ` · exit ${exit}` : ''}
          </div>
          <pre ref={outRef} style={{ maxHeight: 280 }}>{out || '(no output yet)'}</pre>
        </div>
      )}
    </div>
  );
}
