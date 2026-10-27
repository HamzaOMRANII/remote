# Deploy — remote.omranisystems.com

Same pattern as `server_monitoring`: the app binds `127.0.0.1:16010`, nginx is
the public door (wildcard `*.omranisystems.com` Cloudflare origin cert set at
the `http{}` level, inherited), pm2 keeps it running.

## Steps (run on the box)

```bash
cd /projects/remote
git pull
npm install
cp config.example.json config.json     # set password, sessionSecret, agentToken
npm run build

# 1. pm2 — add the entry from deploy/ecosystem.snippet.js to
#    /projects/ecosystem.config.js, then:
pm2 start /projects/ecosystem.config.js --only remote
pm2 save

# 2. nginx — install the vhost and reload:
cp deploy/nginx.conf /etc/nginx/conf.d/remote.conf
nginx -t && nginx -s reload
```

## Verify

```bash
curl -s http://127.0.0.1:16010/healthz                                   # -> ok
curl -sk --resolve remote.omranisystems.com:443:127.0.0.1 \
     https://remote.omranisystems.com/healthz                            # -> ok
```

Dashboard: https://remote.omranisystems.com (password from config.json).

## Cloudflare

The DNS record `remote.omranisystems.com` is proxied (orange cloud). That's fine
for the dashboard and for WSS on 443 (`/ws`, `/agent`). WebSocket idle timeout:
the app sends a 30 s heartbeat, under Cloudflare's ~100 s cutoff.

**M2 (camera / TURN):** coturn's UDP media cannot go through the Cloudflare proxy.
Either put the box's public IP directly in the ICE config, or add a
`turn.omranisystems.com` A-record set to **DNS-only (grey cloud)**.

## Updating

```bash
cd /projects/remote && git pull && npm install && npm run build && pm2 restart remote
```
