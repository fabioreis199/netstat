#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)

APP="NetStat"
var_tags="proxmox-monitoring"
var_cpu="1"
var_ram="256"
var_disk="1"
var_os="alpine"
var_version="3.20"

header_info "$APP"
variables
color
catch_errors

start
build_container

msg_info "Installing NetStat..."
pct exec $CTID -- apk add --no-cache nodejs-lts npm git curl
pct exec $CTID -- bash -c "mkdir -p /opt && cd /opt && git clone https://github.com/fabioreis199/netstat.git"
pct exec $CTID -- bash -c "cd /opt/netstat && npm install && npm run build"
pct exec $CTID -- bash -c "cat > /opt/start.sh << 'STARTEOF'
#!/bin/sh
cd /opt/netstat
PROXMOX_HOST=192.168.1.199 PROXMOX_TOKEN_USER=root@pam PROXMOX_TOKEN_SECRET=a4f4b012-8211-4786-bf8e-51ccd1f3af3f node server.cjs
STARTEOF
chmod +x /opt/start.sh"
pct exec $CTID -- /opt/start.sh &

description
msg_ok "Done! Access at http://\${IP}:3001"
