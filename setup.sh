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

start
build_container

description
msg_ok "Completed successfully!\n"
echo -e "${CREATING}${GN}${APP} setup has been successfully initialized!${CL}"
echo -e "${INFO}${YW} Access it using the following URL:${CL}"
echo -e "${TAB}${GATEWAY}${BGN}http://\${IP}:3001${CL}"
