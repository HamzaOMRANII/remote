import { useMemo } from 'react';
import qrcode from 'qrcode-generator';

// QR code as inline SVG. Always dark-on-white with a quiet zone, whatever the
// theme — phone scanners need the contrast.
export default function QrCode({ text, size = 200, label }) {
  const { n, path } = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const count = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    }
    return { n: count + 8, path: d };
  }, [text]);

  return (
    <svg className="qr" width={size} height={size} viewBox={`0 0 ${n} ${n}`} role="img"
      aria-label={label || 'QR code'} shapeRendering="crispEdges">
      <rect width={n} height={n} fill="#fff" />
      <path d={path} fill="#050B14" />
    </svg>
  );
}
