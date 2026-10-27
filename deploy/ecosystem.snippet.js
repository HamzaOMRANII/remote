// Append this entry to /projects/ecosystem.config.js (the box's shared pm2
// config), alongside the other apps, then: pm2 start ecosystem.config.js --only remote
{
  name: "remote",
  cwd: "/projects/remote",
  script: "npm",
  args: "start",
  env: { NODE_ENV: "production", PORT: 16010, HOST: "127.0.0.1" },
  max_memory_restart: "300M",
}
