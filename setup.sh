#!/usr/bin/env bash
source <(curl -fsSL https://raw.githubusercontent.com/community-scripts/ProxmoxVE/main/misc/build.func)

APP="NetStat"
var_tags="${var_tags:-proxmox|monitoring}"
var_cpu="${var_cpu:-1}"
var_ram="${var_ram:-256}"
var_disk="${var_disk:-1}"
var_os="${var_os:-alpine}"
var_version="${var_version:-3.20}"

header_info "$APP"
variables
color
catch_errors

function update_script() {
  header_info
  if [[ ! -d /opt/netstat ]]; then
    msg_error "No NetStat Installation Found!"
    exit
  fi
  msg_info "Updating NetStat..."
  cd /opt/netstat
  git pull
  cd netstat && npm install && npm run build
  msg_ok "Updated successfully!"
  exit
}

function custom_settings() {
  header_info
  # Set variables for post-install
  export ct_type="1"
  export features="nesting=1,keyctl=1"
}

start
build_container

# Post-install: Install and run NetStat
msg_info "Installing NetStat dependencies..."
 pct exec $CTID -- apk add --no-cache nodejs npm git curl

msg_info "Cloning NetStat repo..."
 pct exec $CTID -- bash -c "mkdir -p /opt && cd /opt && git clone https://github.com/fabioreis199/netstat.git netstat"

msg_info "Building UI..."
 pct exec $CTID -- bash -c "cd /opt/netstat/netstat && npm install && npm run build"

msg_info "Installing API..."
 pct exec $CTID -- bash -c "cd /opt/netstat/homeboard && npm install"

msg_info "Creating startup script..."
 pct exec $CTID -- bash -c "cat > /opt/start.sh << 'STARTEOF'
#!/bin/sh
cd /opt/netstat/homeboard
PROXMOX_HOST=192.168.1.199 PROXMOX_TOKEN_USER=root@pam PROXMOX_TOKEN_SECRET=a4f4b012-8211-4786-bf8e-51ccd1f3af3f node server.cjs
STARTEOF
chmod +x /opt/start.sh"

msg_info "Starting NetStat..."
 pct exec $CTID -- /opt/start.sh &

description
msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://\${IP}:3001${CL}"
