#!/usr/bin/env python3
"""Simulated cameras for testing discovery and access (M7). Run INSIDE an isolated network namespace:
   ip netns add camlab && ip netns exec camlab sh -c 'ip link set lo up; ip link add d0 type dummy;
   for a in 2 10 11 12; do ip addr add 10.77.0.$a/24 dev d0; done; ip link set d0 up'
   ip netns exec camlab python3 camlab.py
  10.77.0.10  "Hikvision": ONVIF discovery (UDP 3702) + ONVIF SOAP on :80 (WS-Security digest checked),
              RTSP :554 with Digest auth, /Streaming/Channels/101 (main) and /102 (sub)
  10.77.0.11  "Dahua"-like: no ONVIF; RTSP :554 Digest, /cam/realmonitor?channel=1&subtype=0|1; :37777, :80
  10.77.0.12  router-like: web :8080 only
Test credentials: admin / Cam-Pass-123. No real video: DESCRIBE answers a valid SDP, which is all the
discovery/access code needs."""
import base64, hashlib, re, socket, threading, time

USER, PASS = "admin", "Cam-Pass-123"
REALM, NONCE = "IP Camera(lab)", "a1b2c3d4e5f60718"
RTSP_PATHS = {
    "10.77.0.10": {"/Streaming/Channels/101", "/Streaming/Channels/102"},
    "10.77.0.11": {"/cam/realmonitor?channel=1&subtype=0", "/cam/realmonitor?channel=1&subtype=1"},
}
SDP = "v=0\r\no=- 0 0 IN IP4 0.0.0.0\r\ns=lab\r\nt=0 0\r\nm=video 0 RTP/AVP 96\r\na=rtpmap:96 H264/90000\r\na=control:trackID=1\r\n"
PROBE_MATCH = """<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
 xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<e:Header><w:RelatesTo>{rel}</w:RelatesTo></e:Header><e:Body><d:ProbeMatches><d:ProbeMatch>
<d:Types>dn:NetworkVideoTransmitter</d:Types>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/HIKVISION onvif://www.onvif.org/hardware/DS-2CD2143G0-I onvif://www.onvif.org/location/city/hangzhou</d:Scopes>
<d:XAddrs>http://10.77.0.10/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>"""
stats = {"onvif_ok": 0, "onvif_denied": 0, "rtsp_ok": 0, "rtsp_denied": 0}

def env(body):
    return ('<?xml version="1.0" encoding="UTF-8"?><s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope" '
            'xmlns:trt="http://www.onvif.org/ver10/media/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema" '
            'xmlns:tds="http://www.onvif.org/ver10/device/wsdl"><s:Body>' + body + '</s:Body></s:Envelope>')

def ws_security_ok(xml):
    try:
        user = re.search(r"<Username>([^<]*)<", xml).group(1)
        digest = re.search(r"<Password[^>]*>([^<]*)<", xml).group(1)
        nonce = base64.b64decode(re.search(r"<Nonce[^>]*>([^<]*)<", xml).group(1))
        created = re.search(r"<Created[^>]*>([^<]*)<", xml).group(1)
    except Exception:
        return False
    expect = base64.b64encode(hashlib.sha1(nonce + created.encode() + PASS.encode()).digest()).decode()
    return user == USER and digest == expect

def onvif_http(conn):
    data = b""
    while b"\r\n\r\n" not in data:
        chunk = conn.recv(65536)
        if not chunk: return
        data += chunk
    head, _, body = data.partition(b"\r\n\r\n")
    m = re.search(rb"Content-Length:\s*(\d+)", head, re.I)
    n = int(m.group(1)) if m else 0
    while len(body) < n:
        body += conn.recv(65536)
    xml = body.decode("utf-8", "replace")
    if not xml.strip():  # a plain browser GET of the web page
        page = b"<html><body>Lab camera web page</body></html>"
        conn.sendall(b"HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: %d\r\n\r\n" % len(page) + page); return
    if not ws_security_ok(xml):
        stats["onvif_denied"] += 1
        out = env('<s:Fault><s:Code><s:Value>s:Sender</s:Value><s:Subcode><s:Value>ter:NotAuthorized</s:Value></s:Subcode></s:Code></s:Fault>')
        status = "400 Bad Request"
    else:
        stats["onvif_ok"] += 1; status = "200 OK"
        if "GetCapabilities" in xml:
            out = env('<tds:GetCapabilitiesResponse><tds:Capabilities><tt:Media><tt:XAddr>http://10.77.0.10/onvif/Media</tt:XAddr></tt:Media></tds:Capabilities></tds:GetCapabilitiesResponse>')
        elif "GetProfiles" in xml:
            out = env('<trt:GetProfilesResponse><trt:Profiles token="Profile_1" fixed="true"><tt:Name>mainStream</tt:Name></trt:Profiles>'
                      '<trt:Profiles token="Profile_2" fixed="true"><tt:Name>subStream</tt:Name></trt:Profiles></trt:GetProfilesResponse>')
        elif "GetStreamUri" in xml:
            ch = "101" if "Profile_1" in xml else "102"
            out = env('<trt:GetStreamUriResponse><trt:MediaUri><tt:Uri>rtsp://10.77.0.10:554/Streaming/Channels/' + ch + '</tt:Uri></trt:MediaUri></trt:GetStreamUriResponse>')
        else:
            out = env(""); status = "400 Bad Request"
    b = out.encode()
    conn.sendall(f"HTTP/1.1 {status}\r\nContent-Type: application/soap+xml\r\nContent-Length: {len(b)}\r\nConnection: close\r\n\r\n".encode() + b)

def md5(s): return hashlib.md5(s.encode()).hexdigest()

def rtsp(conn, ip):
    buf = b""
    while True:
        chunk = conn.recv(65536)
        if not chunk: return
        buf += chunk
        while b"\r\n\r\n" in buf:
            req, _, buf = buf.partition(b"\r\n\r\n")
            text = req.decode("utf-8", "replace")
            cseq = (re.search(r"CSeq:\s*(\d+)", text, re.I) or [None, "1"])[1]
            method, url = text.split(" ")[0], text.split(" ")[1]
            path = re.sub(r"^rtsp://[^/]+", "", url) or "/"
            if method == "OPTIONS":
                conn.sendall(f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nPublic: OPTIONS, DESCRIBE\r\n\r\n".encode()); continue
            auth = re.search(r"Authorization:\s*Digest (.+)", text, re.I)
            ok = False
            if auth:
                p = dict(re.findall(r'(\w+)="([^"]*)"', auth.group(1)))
                ha1 = md5(USER + ":" + REALM + ":" + PASS)
                ha2 = md5(method + ":" + p.get("uri", ""))
                ok = p.get("username") == USER and p.get("response") == md5(ha1 + ":" + NONCE + ":" + ha2)
            if not ok:
                if auth: stats["rtsp_denied"] += 1
                conn.sendall(f'RTSP/1.0 401 Unauthorized\r\nCSeq: {cseq}\r\nWWW-Authenticate: Digest realm="{REALM}", nonce="{NONCE}"\r\n\r\n'.encode()); continue
            if path not in RTSP_PATHS.get(ip, set()):
                conn.sendall(f"RTSP/1.0 404 Stream Not Found\r\nCSeq: {cseq}\r\n\r\n".encode()); continue
            stats["rtsp_ok"] += 1
            conn.sendall(f"RTSP/1.0 200 OK\r\nCSeq: {cseq}\r\nContent-Type: application/sdp\r\nContent-Base: {url}/\r\nContent-Length: {len(SDP)}\r\n\r\n{SDP}".encode())

def serve(ip, port, handler):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((ip, port)); s.listen(128)
    while True:
        c, _ = s.accept()
        def run(c=c):
            try:
                c.settimeout(10); handler(c)
            except Exception:
                pass
            finally:
                c.close()
        threading.Thread(target=run, daemon=True).start()

def accept_close(c): pass

def onvif_discovery():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("10.77.0.10", 3702))
    while True:
        data, addr = s.recvfrom(65535)
        m = re.search(rb"MessageID>([^<]+)<", data)
        if b"Probe" in data:
            s.sendto(PROBE_MATCH.format(rel=(m.group(1).decode() if m else "")).encode(), addr)

SERVICES = [("10.77.0.10", 80, onvif_http), ("10.77.0.10", 554, lambda c: rtsp(c, "10.77.0.10")),
            ("10.77.0.11", 554, lambda c: rtsp(c, "10.77.0.11")), ("10.77.0.11", 37777, accept_close),
            ("10.77.0.11", 80, accept_close), ("10.77.0.12", 8080, accept_close)]
for ip, port, h in SERVICES:
    threading.Thread(target=serve, args=(ip, port, h), daemon=True).start()
threading.Thread(target=onvif_discovery, daemon=True).start()
print("camlab ready", flush=True)
while True:
    time.sleep(30)
