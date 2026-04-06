# NetStat Installer

## One-Line Install

```bash
bash <(curl -s https://raw.githubusercontent.com/fabioreis199/netstat/main/install.sh)
```

## What It Does

1. Creates a Debian 12 LXC (256MB RAM, 1GB disk)
2. Installs Node.js, npm, git, curl
3. Clones the NetStat repository
4. Builds the UI
5. Starts the API server on port 3001

## Requirements

- Proxmox VE 7+
- Internet access for downloading templates

## Access

After install, access at: `http://<LXC_IP>:3001`

## Update

To update later:

```bash
pct exec <CTID> -- bash -c "cd /opt/netstat && git pull && npm install && npm run build"
pct restart <CTID>
```
