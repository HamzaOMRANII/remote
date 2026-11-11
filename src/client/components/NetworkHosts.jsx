// The devices found on the owner's network (M7): cameras first, then "maybe" (web/vendor ports only).
// Used by the dashboard's Network panel and the app's "My network" section.

const KIND = { camera: 'Camera', maybe: 'Maybe a camera', other: 'Device' };

export function mergeHost(list, host) {
  const i = list.findIndex((h) => h.ip === host.ip);
  if (i < 0) return [...list, host];
  const next = list.slice();
  next[i] = { ...list[i], ...host };
  return next;
}

const rank = (h) => (h.kind === 'camera' ? 0 : h.kind === 'maybe' ? 1 : 2);
const ipNum = (ip) => ip.split('.').reduce((n, o) => n * 256 + Number(o), 0);

export default function NetworkHosts({ hosts, scanning }) {
  const shown = hosts.slice().sort((a, b) => rank(a) - rank(b) || ipNum(a.ip) - ipNum(b.ip));
  if (!shown.length) {
    return <p className="muted rem-sub" style={{ margin: 0 }}>{scanning ? 'Looking…' : 'Nothing found yet.'}</p>;
  }
  return (
    <ul className="net-hosts">
      {shown.map((h) => (
        <li key={h.ip} className={`net-host ${h.kind}`}>
          <div className="net-host-top">
            <span className="mono net-ip">{h.ip}</span>
            <span className={`net-kind ${h.kind}`}>{KIND[h.kind] || h.kind}</span>
          </div>
          {(h.manufacturer || h.model) && (
            <div className="net-model">{[h.manufacturer, h.model].filter(Boolean).join(' · ')}</div>
          )}
          <div className="net-ports">
            {(h.ports || []).map((p) => (
              <span key={p.port} className="net-port mono" title={p.label}>{p.port} <small>{p.label}</small></span>
            ))}
            {h.onvif && <span className="net-port mono" title={h.onvif}>ONVIF</span>}
          </div>
        </li>
      ))}
    </ul>
  );
}
