#!/usr/bin/env python3
"""Simulated cameras for testing discovery (M7). Run INSIDE an isolated network namespace, e.g.
   ip netns add camlab && ip netns exec camlab sh -c 'ip link set lo up; ip link add d0 type dummy;
   for a in 2 10 11 12; do ip addr add 10.77.0.$a/24 dev d0; done; ip link set d0 up'
   ip netns exec camlab python3 camlab.py
  10.77.0.10  "Hikvision" camera: ONVIF answer (UDP 3702), RTSP 554, web 80
  10.77.0.11  "Dahua"-like device: 37777 + web 80 (no ONVIF)
  10.77.0.12  router-like: web 8080 only
Nothing here logs in or checks passwords: it only accepts connections (and answers ONVIF probes)."""
import re, socket, threading

TCP = {"10.77.0.10": [554, 80], "10.77.0.11": [37777, 80], "10.77.0.12": [8080]}
PROBE_MATCH = """<?xml version="1.0" encoding="UTF-8"?><e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope"
 xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery">
<e:Header><w:RelatesTo>{rel}</w:RelatesTo></e:Header><e:Body><d:ProbeMatches><d:ProbeMatch>
<d:Types>dn:NetworkVideoTransmitter</d:Types>
<d:Scopes>onvif://www.onvif.org/type/video_encoder onvif://www.onvif.org/name/HIKVISION onvif://www.onvif.org/hardware/DS-2CD2143G0-I onvif://www.onvif.org/location/city/hangzhou</d:Scopes>
<d:XAddrs>http://10.77.0.10/onvif/device_service</d:XAddrs></d:ProbeMatch></d:ProbeMatches></e:Body></e:Envelope>"""

def tcp(ip, port):
    s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); s.bind((ip, port)); s.listen(64)
    while True:
        c, _ = s.accept(); c.close()

def onvif():
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.bind(("10.77.0.10", 3702))
    while True:
        data, addr = s.recvfrom(65535)
        m = re.search(rb"MessageID>([^<]+)<", data)
        if b"Probe" in data:
            s.sendto(PROBE_MATCH.format(rel=(m.group(1).decode() if m else "")).encode(), addr)

for ip, ports in TCP.items():
    for p in ports: threading.Thread(target=tcp, args=(ip, p), daemon=True).start()
threading.Thread(target=onvif, daemon=True).start()
print("camlab ready", flush=True)
threading.Event().wait()
