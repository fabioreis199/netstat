#!/bin/bash
# NetStat LXC Setup Script - Alpine Linux (minimal footprint)
# Run this on your Proxmox node

set -e

# Configuration
LXC_NAME="netstat"
LXC_ID="130"
LXC_RAM="256"
LXC_CORES="1"
LXC_ROOT="1"
GIT_REPO="https://github.com/fabioreis199/netstat.git"
API_TOKEN="your-proxmox-api-token-here"
PROXMOX_HOST="192.168.1.199"

echo "==> Creating NetStat LXC (Alpine)..."

# Create Alpine LXC
pct create ${LXC_ID} local:vztmpl/alpine-3.20-default_3.20.1_amd64.tar.gz \
  --hostname ${LXC_NAME} \
  --cores ${LXC_CORES} \
  --memory ${LXC_RAM} \
  --rootfs local:${LXC_ROOT} \
  --net0 name=eth0,bridge=vmbr0,ip=dhcp \
  --onboot 1 \
  --unprivileged 1 \
  --features keyctl=1,nesting=1

# Start LXC
pct start ${LXC_ID}
sleep 5

# Install Node.js and dependencies
echo "==> Installing Node.js..."
pct exec ${LXC_ID} -- apk add --no-cache nodejs npm git curl

# Clone repo
echo "==> Cloning NetStat..."
pct exec ${LXC_ID} -- mkdir -p /opt
pct exec ${LXC_ID} -- bash -c "cd /opt && git clone ${GIT_REPO} netstat"

# Install and build
echo "==> Building UI..."
pct exec ${LXC_ID} -- bash -c "cd /opt/netstat && npm install && npm run build"

# Setup API environment
echo "==> Setting up API..."
pct exec ${LXC_ID} -- bash -c "mkdir -p /opt/homeboard"

# Copy server
cat > /tmp/server.cjs << 'SERVEREOF'
const express = require('express');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PROXMOX_HOST = process.env.PROXMOX_HOST || '192.168.1.199';
const PROXMOX_TOKEN_USER = process.env.PROXMOX_TOKEN_USER || 'root@pam';
const PROXMOX_TOKEN_SECRET = process.env.PROXMOX_TOKEN_SECRET || 'a4f4b012-8211-4786-bf8e-51ccd1f3af3f';
const PORT = process.env.PORT || 3001;

const PROXMOX_TOKEN = \`\${PROXMOX_TOKEN_USER}!\${PROXMOX_TOKEN_SECRET}\`;

function proxmoxApiCall(endpoint, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = \`https://\${PROXMOX_HOST}:8006/api2/json\${endpoint}\`;
    const options = {
      headers: {
        'Authorization': \`PVEAPIToken=\${PROXMOX_TOKEN}\`,
        'Content-Type': 'application/json'
      },
      rejectUnauthorized: false,
      method: method
    };
    
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

const app = express();
app.use(express.json());

const UI_PATH = path.join(__dirname, 'netstat/dist');
app.use(express.static(UI_PATH));
app.get('/', (req, res) => { res.sendFile(path.join(UI_PATH, 'index.html')); });

app.get('/api/proxmox', async (req, res) => {
  try {
    const [cluster, nodes, storage, vms] = await Promise.all([
      proxmoxApiCall('/cluster/status'),
      proxmoxApiCall('/nodes'),
      proxmoxApiCall('/cluster/storage'),
      proxmoxApiCall('/cluster/resources')
    ]);
    
    const nodeData = nodes.data || [];
    const storages = (storage.data || []).map(s => ({
      name: s.storage, type: s.type, total: s.total, used: s.used, available: s.avail,
      percent: Math.round((s.used / s.total) * 100)
    }));
    
    const resources = vms.data || [];
    const running = resources.filter(r => r.status === 'running').length;
    const total = resources.length;
    
    res.json({
      nodes: nodeData.map(n => ({ name: n.node, status: n.uptime ? 'online' : 'offline', cpu: n.cpu, mem: n.mem, maxmem: n.maxmem, uptime: n.uptime })),
      storage: storages,
      vms: { total, running }
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(\`NetStat API running on port \${PORT}\`);
});
SERVEREOF

pct exec ${LXC_ID} -- mkdir -p /opt/homeboard
pct push ${LXC_ID} /tmp/server.cjs /opt/homeboard/server.cjs

# Create startup script
pct exec ${LXC_ID} -- bash -c "cat > /opt/start.sh << 'EOF'
#!/bin/sh
cd /opt/homeboard
PROXMOX_HOST=${PROXMOX_HOST:-192.168.1.199} \\
PROXMOX_TOKEN_USER=${PROXMOX_TOKEN_USER:-root@pam} \\
PROXMOX_TOKEN_SECRET=${PROXMOX_TOKEN_SECRET:-a4f4b012-8211-4786-bf8e-51ccd1f3af3f} \\
node server.cjs
EOF
chmod +x /opt/start.sh"

# Create init script
pct exec ${LXC_ID} -- bash -c "cat > /etc/init.d/netstat << 'EOF'
#!/bin/sh
NAME=netstat
DAEMON=/opt/start.sh
PIDFILE=/var/run/netstat.pid

case \"\$1\" in
  start)
    echo \"Starting \$NAME...\"
    \$DAEMON &
    echo \$! > \$PIDFILE
    ;;
  stop)
    echo \"Stopping \$NAME...\"
    kill \$(cat \$PIDFILE) 2>/dev/null
    rm -f \$PIDFILE
    ;;
  restart)
    \$0 stop
    \$0 start
    ;;
esac
exit 0
EOF
chmod +x /etc/init.d/netstat
rc-update add netstat default"

echo "==> Starting NetStat..."
pct exec ${LXC_ID} -- /opt/start.sh &

echo ""
echo "==> Done! NetStat running at:"
echo "    http://<LXC_IP>:3001"
echo ""
echo "To update later, run inside LXC:"
echo "  cd /opt/netstat && git pull && npm install && npm run build"
echo "  pct restart ${LXC_ID}"
