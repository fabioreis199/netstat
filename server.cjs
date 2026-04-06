const express = require('express');
const { exec } = require('child_process');
const cors = require('cors');
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Serve UI static files
const UI_PATH = path.join(__dirname, '../netstat/dist');
app.use(express.static(UI_PATH));
app.get('/', (req, res) => { res.sendFile(path.join(UI_PATH, 'index.html')); });

const DB_PATH = path.join(__dirname, 'homeboard.db');
let db;
const JOB_MAX_RETRIES_DEFAULT = 2;
const SECRET_KEY = crypto
  .createHash('sha256')
  .update(process.env.HOMEBOARD_SECRET_KEY || 'homeboard-dev-secret-change-me')
  .digest();

function nowIso() {
  return new Date().toISOString();
}

function parseRows(resultSet) {
  if (!resultSet?.[0]) return [];
  const { columns, values } = resultSet[0];
  return values.map((row) => Object.fromEntries(row.map((value, idx) => [columns[idx], value])));
}

function safeJsonParse(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function encryptSecret(plainText) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', SECRET_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: encrypted.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

function decryptSecret(payload) {
  const iv = Buffer.from(payload.iv, 'base64');
  const tag = Buffer.from(payload.tag, 'base64');
  const encrypted = Buffer.from(payload.ciphertext, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', SECRET_KEY, iv);
  decipher.setAuthTag(tag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString('utf8');
}

// Initialize SQLite database
async function initDB() {
  const SQL = await initSqlJs();
  
  // Load existing DB or create new
  if (fs.existsSync(DB_PATH)) {
    const buffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(buffer);
    console.log('Loaded existing database');
  } else {
    db = new SQL.Database();
    console.log('Created new database');
  }
  
  // Create tables
  db.run(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS devices (
      ip TEXT PRIMARY KEY,
      name TEXT,
      mac TEXT,
      last_seen DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      time TEXT,
      level TEXT,
      source TEXT,
      message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  db.run(`
    CREATE TABLE IF NOT EXISTS history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      metric TEXT,
      value REAL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      mode TEXT DEFAULT 'local',
      capabilities TEXT,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action TEXT NOT NULL,
      target TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      dry_run INTEGER DEFAULT 0,
      rollback_of INTEGER,
      rollback_command TEXT,
      payload TEXT,
      output TEXT,
      error TEXT,
      attempts INTEGER DEFAULT 0,
      max_retries INTEGER DEFAULT 2,
      timeout_ms INTEGER DEFAULT 30000,
      created_by TEXT DEFAULT 'anonymous',
      created_from TEXT DEFAULT 'unknown',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      started_at DATETIME,
      completed_at DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS service_checks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      target TEXT NOT NULL,
      check_type TEXT NOT NULL,
      threshold_failures INTEGER DEFAULT 3,
      depends_on TEXT,
      enabled INTEGER DEFAULT 1,
      last_status TEXT DEFAULT 'unknown',
      last_latency_ms INTEGER,
      failure_count INTEGER DEFAULT 0,
      last_checked_at DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dedup_key TEXT UNIQUE,
      source_type TEXT NOT NULL,
      source_id TEXT,
      severity TEXT DEFAULT 'warning',
      status TEXT DEFAULT 'open',
      title TEXT NOT NULL,
      details TEXT,
      acknowledged_by TEXT,
      acknowledged_at DATETIME,
      silenced_until DATETIME,
      alert_sent_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS alert_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      target TEXT NOT NULL,
      enabled INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hostname TEXT,
      ip TEXT,
      mac TEXT,
      owner TEXT,
      environment TEXT,
      tags TEXT,
      source TEXT DEFAULT 'manual',
      approved INTEGER DEFAULT 1,
      status TEXT DEFAULT 'active',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS inventory_approvals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ip TEXT,
      hostname TEXT,
      mac TEXT,
      source TEXT DEFAULT 'lan_scan',
      status TEXT DEFAULT 'pending',
      requested_by TEXT DEFAULT 'system',
      requested_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      reviewed_by TEXT,
      reviewed_at DATETIME
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS secrets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      ciphertext TEXT NOT NULL,
      iv TEXT NOT NULL,
      tag TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      actor TEXT NOT NULL,
      source_ip TEXT,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT,
      diff TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  
  // Insert default known devices if empty
  const deviceCount = db.exec("SELECT COUNT(*) FROM devices")[0]?.values[0][0] || 0;
  if (deviceCount === 0) {
    const defaultDevices = [
      ['192.168.1.1', 'Vodafone Gateway', null],
      ['192.168.1.50', 'Reis.lan (Mac)', '90:cc:df:f3:bc:db'],
      ['192.168.1.70', 'EvLaptop.lan', null],
      ['192.168.1.145', 'truenas.lan', null],
      ['192.168.1.184', 'Air-de-Fabio', null],
    ];
    const stmt = db.prepare("INSERT OR REPLACE INTO devices (ip, name, mac) VALUES (?, ?, ?)");
    defaultDevices.forEach(d => stmt.run(d));
    stmt.free();
  }

  const agentCount = db.exec("SELECT COUNT(*) FROM agents")[0]?.values?.[0]?.[0] || 0;
  if (agentCount === 0) {
    const stmt = db.prepare("INSERT INTO agents (id, name, host, mode, capabilities, enabled) VALUES (?, ?, ?, ?, ?, ?)");
    stmt.run(['local-agent', 'Local Control Agent', 'localhost', 'local', JSON.stringify(['system.reboot', 'system.shutdown', 'services.restart']), 1]);
    stmt.free();
  }
  
  // Save to file
  saveDB();
  console.log('Database initialized');
}

function saveDB() {
  const data = db.export();
  const buffer = Buffer.from(data);
  fs.writeFileSync(DB_PATH, buffer);
}

function getConfigValue(key) {
  const stmt = db.prepare('SELECT value FROM config WHERE key = ?');
  stmt.bind([key]);
  let value;
  if (stmt.step()) {
    const raw = stmt.get()[0];
    try {
      value = JSON.parse(raw);
    } catch {
      value = raw;
    }
  }
  stmt.free();
  return value;
}

function requestMeta(req) {
  return {
    actor: req.headers['x-actor'] || 'anonymous',
    sourceIp: req.headers['x-forwarded-for'] || req.ip || 'unknown',
  };
}

function writeAudit({ actor = 'anonymous', sourceIp = 'unknown', action, entityType, entityId = null, diff = null }) {
  const stmt = db.prepare(
    "INSERT INTO audit_log (actor, source_ip, action, entity_type, entity_id, diff) VALUES (?, ?, ?, ?, ?, ?)"
  );
  stmt.run([actor, sourceIp, action, entityType, entityId, diff ? JSON.stringify(diff) : null]);
  stmt.free();
}

// Config endpoints
app.get('/api/config', (req, res) => {
  const results = db.exec("SELECT key, value FROM config");
  const config = {};
  if (results[0]) {
    results[0].values.forEach(([key, value]) => {
      try { config[key] = JSON.parse(value); }
      catch { config[key] = value; }
    });
  }
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const meta = requestMeta(req);
  const { key, value } = req.body || {};

  if (key) {
    const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
    stmt.run([key, JSON.stringify(value)]);
    stmt.free();
    saveDB();
    writeAudit({ ...meta, action: 'config.update', entityType: 'config', entityId: key, diff: { value } });
    return res.json({ success: true, mode: 'single' });
  }

  const incoming = req.body;
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
    return res.status(400).json({ error: 'Send either { key, value } or a config object' });
  }

  const stmt = db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)');
  Object.entries(incoming).forEach(([cfgKey, cfgValue]) => {
    stmt.run([cfgKey, JSON.stringify(cfgValue)]);
  });
  stmt.free();
  saveDB();
  writeAudit({ ...meta, action: 'config.bulk_update', entityType: 'config', entityId: '*', diff: incoming });
  res.json({ success: true, mode: 'bulk' });
});

app.get('/api/devices', (req, res) => {
  const results = db.exec("SELECT ip, name, mac, last_seen FROM devices ORDER BY ip");
  const devices = results[0]?.values || [];
  res.json({ 
    devices: devices.map(([ip, name, mac, last_seen]) => ({ ip, name, mac, last_seen }))
  });
});

app.post('/api/devices', (req, res) => {
  const meta = requestMeta(req);
  const { ip, name, mac } = req.body;
  if (!ip || !name) return res.status(400).json({ error: 'ip and name required' });
  
  const stmt = db.prepare("INSERT OR REPLACE INTO devices (ip, name, mac) VALUES (?, ?, ?)");
  stmt.run([ip, name, mac || null]);
  stmt.free();
  saveDB();
  writeAudit({ ...meta, action: 'device.upsert', entityType: 'device', entityId: ip, diff: { ip, name, mac } });
  res.json({ success: true });
});

// Logs endpoints
app.get('/api/logs', (req, res) => {
  const limit = req.query.limit || 100;
  const results = db.exec(`SELECT time, level, source, message FROM logs ORDER BY id DESC LIMIT ${limit}`);
  const logs = results[0]?.values || [];
  res.json({ 
    logs: logs.map(([time, level, source, message]) => ({ time, level, source, message }))
  });
});

app.post('/api/logs', (req, res) => {
  const { level, source, message } = req.body;
  const time = new Date().toISOString().split('T')[1].split('.')[0];
  
  const stmt = db.prepare("INSERT INTO logs (time, level, source, message) VALUES (?, ?, ?, ?)");
  stmt.run([time, level || 'info', source || 'system', message || '']);
  stmt.free();
  saveDB();
  res.json({ success: true });
});

// History/metrics endpoint
app.get('/api/history/:metric', (req, res) => {
  const { metric } = req.params;
  const limit = req.query.limit || 100;
  const results = db.exec(`
    SELECT value, created_at FROM history 
    WHERE metric = '${metric}' 
    ORDER BY id DESC 
    LIMIT ${limit}
  `);
  const data = results[0]?.values || [];
  res.json({ 
    metric,
    data: data.map(([value, created_at]) => ({ value, time: created_at }))
  });
});

app.post('/api/history', (req, res) => {
  const { metric, value } = req.body;
  if (!metric || value === undefined) return res.status(400).json({ error: 'metric and value required' });
  
  const stmt = db.prepare("INSERT INTO history (metric, value) VALUES (?, ?)");
  stmt.run([metric, value]);
  stmt.free();
  
  // Keep only last 1000 entries per metric
  db.run(`
    DELETE FROM history 
    WHERE id NOT IN (
      SELECT id FROM history WHERE metric = '${metric}' ORDER BY id DESC LIMIT 1000
    )
  `);
  saveDB();
  res.json({ success: true });
});

// Helper to run command and return promise
function runCmd(cmd) {
  return new Promise((resolve) => {
    exec(cmd, (err, stdout) => resolve(err ? '' : stdout));
  });
}

// System stats endpoint
app.get('/api/system', async (req, res) => {
  const uptime = await runCmd('uptime');
  const cpuCores = await runCmd('sysctl -n hw.ncpu');
  const vmStat = await runCmd('vm_stat');
  const disk = await runCmd('df -h / | tail -1');
  
  const pagesMatch = vmStat.match(/Pages active:\s+(\d+)/);
  const freeMatch = vmStat.match(/Pages free:\s+(\d+)/);
  const activePages = pagesMatch ? parseInt(pagesMatch[1]) : 0;
  const freePages = freeMatch ? parseInt(freeMatch[1]) : 0;
  const memUsedGB = Math.round((activePages * 4096) / (1024 * 1024 * 1024) * 10) / 10;
  
  const diskParts = disk.trim().split(/\s+/);
  
  const response = {
    hostname: 'Air-de-Fabio',
    os: 'macOS 26.4.0',
    kernel: 'Darwin 25.5.0',
    model: 'MacBook Air (M4, 2024)',
    cpu: 'Apple M4 (4P + 6E cores)',
    memory: { used: memUsedGB, total: 24 },
    storage: { 
      used: parseFloat(diskParts[2]?.replace('i', '') || '0'), 
      total: parseFloat(diskParts[1]?.replace('i', '') || '0') 
    },
    uptime: uptime.replace('up ', '').split(',')[0].trim(),
    load: uptime.match(/load averages: ([\d.]+)/)?.[1] || '0',
    processes: await runCmd('ps -ax | wc -l').then(r => parseInt(r.trim()) || 0),
  };
  
  // Save to history
  const stmt = db.prepare("INSERT INTO history (metric, value) VALUES (?, ?)");
  stmt.run(['cpu', parseFloat(response.load) * 100]);
  stmt.run(['memory', response.memory.used / response.memory.total * 100]);
  stmt.free();
  saveDB();
  
  res.json(response);
});

// Network endpoint
app.get('/api/network', async (req, res) => {
  const ifconfig = await runCmd('ifconfig');
  const netstat = await runCmd('netstat -an | grep ESTABLISHED | wc -l');
  const dns = await runCmd('scutil --dns | grep nameserver | head -5');
  
  const interfaces = [];
  const lines = ifconfig.split('\n');
  let currentIface = null;
  
  for (const line of lines) {
    if (line.match(/^(en\d+|lo\d+|utun\d+):/)) {
      currentIface = line.replace(':', '').trim();
    } else if (currentIface && line.includes('inet ')) {
      const ip = line.match(/inet (\d+\.\d+\.\d+\.\d+)/)?.[1];
      const mac = line.match(/ether ([a-f0-9:]+)/)?.[1];
      const status = line.includes('UP') ? 'up' : 'down';
      const type = currentIface.startsWith('en') ? 'Wi-Fi' : 
                   currentIface.startsWith('lo') ? 'Loopback' : 
                   currentIface.startsWith('utun') ? 'VPN' : 'Other';
      interfaces.push({ name: currentIface, ip: ip || 'N/A', mac: mac || 'N/A', status, type });
      currentIface = null;
    }
  }
  
  const dnsServers = dns.split('\n')
    .filter(l => l.includes('nameserver'))
    .map(l => l.match(/nameserver\[0\] : ([\d.]+)/)?.[1])
    .filter(Boolean);
  
  const routes = [
    { dest: 'default', gateway: '192.168.1.1', interface: 'en0' },
    { dest: '127.0.0.1', gateway: '-', interface: 'lo0' },
    { dest: '192.168.1.0/24', gateway: '-', interface: 'en0' },
  ];
  
  res.json({
    interfaces,
    connections: parseInt(netstat.trim()) || 0,
    dns: dnsServers.length ? dnsServers : ['1.1.1.1', '8.8.8.8'],
    routes
  });
});

app.get('/api/network-targets', async (req, res) => {
  const configuredTargets = getConfigValue('networkTargets');
  const targets = (Array.isArray(configuredTargets) ? configuredTargets : ['192.168.1.1', '8.8.8.8', '1.1.1.1'])
    .map((target) => String(target).trim())
    .filter(Boolean);

  const checks = await Promise.all(targets.map(async (target) => {
    const start = Date.now();
    const output = await runCmd(`ping -c 1 -W 1 ${target}`);
    const reachable = Boolean(output);
    return {
      target,
      reachable,
      latencyMs: reachable ? Date.now() - start : null,
    };
  }));

  res.json({ targets: checks });
});

// Storage endpoint
app.get('/api/storage', async (req, res) => {
  const df = await runCmd('df -h');
  
  const drives = [];
  const lines = df.split('\n').filter(l => !l.includes('Filesystem') && l.trim());
  
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    const mount = parts[parts.length - 1];
    if (mount === '/' || mount.startsWith('/Volumes') || mount.startsWith('/mnt')) {
      const total = parseFloat(parts[1]?.replace('i', '') || '0');
      const used = parseFloat(parts[2]?.replace('i', '') || '0');
      const type = mount === '/' ? 'SSD' : mount.startsWith('/mnt/nas') ? 'NAS' : 'External';
      drives.push({
        name: mount === '/' ? 'MacBook Air' : mount.split('/').pop(),
        mount,
        total: Math.round(total),
        used: Math.round(used),
        type,
        location: mount === '/' ? 'Local' : 'Network'
      });
    }
  }
  
  res.json({ drives });
});

function checkServiceStatus(url) {
  if (!url) {
    return Promise.resolve('unknown');
  }
  const escaped = String(url).replace(/'/g, "'\\''");
  return runCmd(`curl -I -L --max-time 4 '${escaped}'`).then((output) => (
    output && /(HTTP\/\d(\.\d)?\s+[2-5]\d{2})/.test(output) ? 'online' : 'unknown'
  ));
}

// Services endpoint
app.get('/api/services', async (req, res) => {
  const defaultServices = [
    { name: 'Pterodactyl', url: 'https://pterodactyl.byt.pt', status: 'online', type: 'game' },
    { name: 'Grafana', url: 'https://grafana.byt.pt', status: 'online', type: 'monitoring' },
    { name: 'Prometheus', url: 'https://prometheus.byt.pt', status: 'online', type: 'monitoring' },
    { name: 'pfSense', url: 'https://pfsense.byt.pt', status: 'online', type: 'network' },
    { name: 'Seafile', url: 'https://seafile.byt.pt', status: 'online', type: 'storage' },
    { name: 'Paperless', url: 'https://paperless.byt.pt', status: 'online', type: 'productivity' },
    { name: 'Vaultwarden', url: 'https://vault.byt.pt', status: 'online', type: 'security' },
    { name: 'Jellyfin', url: 'https://jellyfin.byt.pt', status: 'online', type: 'media' },
    { name: 'Sonarr', url: 'https://sonarr.byt.pt', status: 'online', type: 'media' },
    { name: 'Radarr', url: 'https://radarr.byt.pt', status: 'online', type: 'media' },
    { name: 'Wallos', url: 'https://wallos.byt.pt', status: 'online', type: 'finance' },
    { name: 'SearXNG', url: 'https://search.byt.pt', status: 'online', type: 'utility' },
    { name: 'Gitea', url: 'https://gitea.byt.pt', status: 'offline', type: 'dev' },
    { name: 'UniFi', url: 'https://unifi.byt.pt', status: 'online', type: 'network' },
    { name: 'Home Assistant', url: 'https://homeassistant.byt.pt', status: 'offline', type: 'iot' },
  ];

  const configuredServices = getConfigValue('services');
  const sourceServices = Array.isArray(configuredServices) && configuredServices.length
    ? configuredServices
    : defaultServices.map((service) => ({ ...service, enabled: true }));

  const services = await Promise.all(sourceServices.map(async (service) => {
    const checkedStatus = await checkServiceStatus(service.url);
    const status = checkedStatus === 'unknown'
      ? (service.status || 'unknown')
      : checkedStatus;
    return {
      name: service.name || 'Unnamed Service',
      url: service.url || '',
      status,
      type: service.type || 'custom',
      enabled: service.enabled !== false,
    };
  }));

  res.json({ services });
});

// LAN Sweeper
function pingHost(ip) {
  return new Promise((resolve) => {
    const start = Date.now();
    exec(`ping -c 1 -W 1 ${ip}`, (error) => {
      resolve({ ip, online: !error, latency: error ? null : Date.now() - start });
    });
  });
}

function resolveHostname(ip) {
  return new Promise((resolve) => {
    exec(`host ${ip}`, (err, stdout) => {
      if (!err && stdout.includes('domain name pointer')) {
        const match = stdout.match(/domain name pointer ([\w.-]+)\./);
        resolve(match ? match[1] : null);
      } else {
        resolve(null);
      }
    });
  });
}

function resolveMac(ip) {
  return new Promise((resolve) => {
    exec(`arp -n ${ip}`, (err, stdout) => {
      if (err || !stdout) {
        resolve(null);
        return;
      }
      const match = stdout.match(/ at ([0-9a-f:]{17}) /i);
      resolve(match ? match[1].toLowerCase() : null);
    });
  });
}

async function scanSubnet(subnet) {
  const results = [];
  const promises = [];
  
  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}.${i}`;
    promises.push(
      pingHost(ip).then(async (result) => {
        if (result.online) {
          const [hostname, mac, dbInfo] = await Promise.all([
            resolveHostname(ip),
            resolveMac(ip),
            // Check DB for known name
            new Promise((resolve) => {
              const stmt = db.prepare("SELECT name FROM devices WHERE ip = ?");
              stmt.bind([ip]);
              if (stmt.step()) {
                const name = stmt.get()[0];
                resolve(name);
              } else {
                resolve(null);
              }
              stmt.free();
            }),
          ]);
          result.hostname = hostname || dbInfo || 'Unknown';
          result.mac = mac || 'Unknown';
          results.push(result);
        }
      })
    );
    if (i % 20 === 0) await Promise.all(promises);
  }
  
  await Promise.all(promises);
  return results.sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
}

app.get('/api/scan/:subnet', async (req, res) => {
  const { subnet } = req.params;
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(subnet)) {
    return res.status(400).json({ error: 'Invalid subnet' });
  }
  try {
    const devices = await scanSubnet(subnet);
    res.json({ devices });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function serviceNameForPort(port) {
  const map = {
    22: 'SSH', 53: 'DNS', 80: 'HTTP', 110: 'POP3',
    139: 'NetBIOS', 143: 'IMAP', 443: 'HTTPS', 445: 'SMB',
    631: 'IPP', 1900: 'UPnP', 3000: 'Web App',
    3306: 'MySQL', 3389: 'RDP', 5432: 'PostgreSQL',
    8006: 'Proxmox', 8080: 'HTTP Alt', 8096: 'Jellyfin',
    8123: 'Home Assistant', 8443: 'HTTPS Alt',
  };
  return map[port] || 'Unknown';
}

function probePort(ip, port) {
  return new Promise((resolve) => {
    exec(`nc -z -G 1 ${ip} ${port}`, (err) => {
      if (err) {
        resolve(null);
      } else {
        resolve({ port, protocol: 'tcp', state: 'open', service: serviceNameForPort(port) });
      }
    });
  });
}

app.get('/api/ports/:ip', async (req, res) => {
  const { ip } = req.params;
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) {
    return res.status(400).json({ error: 'Invalid IP' });
  }
  
  try {
    const commonPorts = [22, 53, 80, 443, 445, 3389, 3000, 3001, 5432, 6379, 8080, 8096, 8123, 8443, 9000, 9090, 9091, 32400];
    const results = await Promise.all(commonPorts.map((port) => probePort(ip, port)));
    const ports = results.filter(Boolean).sort((a, b) => a.port - b.port);
    res.json({ ports });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getEnabledAgents() {
  return parseRows(db.exec("SELECT * FROM agents WHERE enabled = 1"));
}

function insertJob({ action, target, agentId = 'local-agent', dryRun = false, rollbackOf = null, rollbackCommand = null, payload = {}, maxRetries = JOB_MAX_RETRIES_DEFAULT, timeoutMs = 30000, createdBy = 'anonymous', createdFrom = 'unknown' }) {
  const stmt = db.prepare(`
    INSERT INTO jobs (action, target, agent_id, dry_run, rollback_of, rollback_command, payload, max_retries, timeout_ms, created_by, created_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([
    action,
    target,
    agentId,
    dryRun ? 1 : 0,
    rollbackOf,
    rollbackCommand,
    JSON.stringify(payload),
    maxRetries,
    timeoutMs,
    createdBy,
    createdFrom,
  ]);
  stmt.free();
  const id = db.exec("SELECT last_insert_rowid() as id")[0].values[0][0];
  return id;
}

function mapActionToCommand(action) {
  const commands = {
    'system.reboot': 'echo "reboot requested"',
    'system.shutdown': 'echo "shutdown requested"',
    'services.restart': 'echo "restart services requested"',
  };
  return commands[action] || 'echo "unknown action"';
}

function runCommandWithTimeout(cmd, timeoutMs = 30000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        output: `${stdout || ''}${stderr || ''}`.trim(),
        error: err ? err.message : null,
      });
    });
  });
}

async function executeJob(job) {
  const jobPayload = safeJsonParse(job.payload, {}) || {};
  const isDryRun = Number(job.dry_run) === 1;
  const cmd = mapActionToCommand(job.action);
  const shouldExecuteForReal = process.env.HOMEBOARD_ENABLE_REAL_ACTIONS === '1' && !isDryRun;

  if (!shouldExecuteForReal) {
    return {
      ok: true,
      output: `DRY/SIMULATED: ${job.action} on ${job.target}`,
      error: null,
    };
  }

  const command = jobPayload.commandOverride || cmd;
  return runCommandWithTimeout(command, Number(job.timeout_ms) || 30000);
}

async function processPendingJobs() {
  const rows = parseRows(db.exec(`
    SELECT * FROM jobs
    WHERE status IN ('pending', 'retrying')
    ORDER BY id ASC
    LIMIT 1
  `));
  if (!rows.length) return;

  const job = rows[0];
  const setRunning = db.prepare("UPDATE jobs SET status = 'running', started_at = ? WHERE id = ?");
  setRunning.run([nowIso(), job.id]);
  setRunning.free();
  saveDB();

  const result = await executeJob(job);
  const attempts = Number(job.attempts || 0) + 1;
  const maxRetries = Number(job.max_retries || JOB_MAX_RETRIES_DEFAULT);

  if (result.ok) {
    const complete = db.prepare("UPDATE jobs SET status = 'success', attempts = ?, output = ?, error = NULL, completed_at = ? WHERE id = ?");
    complete.run([attempts, result.output, nowIso(), job.id]);
    complete.free();
  } else if (attempts <= maxRetries) {
    const retry = db.prepare("UPDATE jobs SET status = 'retrying', attempts = ?, error = ? WHERE id = ?");
    retry.run([attempts, result.error, job.id]);
    retry.free();
  } else {
    const fail = db.prepare("UPDATE jobs SET status = 'failed', attempts = ?, output = ?, error = ?, completed_at = ? WHERE id = ?");
    fail.run([attempts, result.output, result.error, nowIso(), job.id]);
    fail.free();
  }
  saveDB();
}

async function runServiceCheck(check) {
  const type = String(check.check_type || '').toLowerCase();
  const target = String(check.target || '').trim();
  const start = Date.now();

  if (!target) {
    return { status: 'unknown', latencyMs: null, error: 'empty target' };
  }

  if (type === 'http') {
    const out = await runCmd(`curl -I -L --max-time 4 '${target.replace(/'/g, "'\\''")}'`);
    return { status: out ? 'online' : 'offline', latencyMs: Date.now() - start, error: out ? null : 'http check failed' };
  }
  if (type === 'tcp') {
    const [host, port] = target.split(':');
    const probe = await runCommandWithTimeout(`nc -z -G 2 ${host} ${port || 80}`, 4000);
    return { status: probe.ok ? 'online' : 'offline', latencyMs: Date.now() - start, error: probe.ok ? null : probe.error };
  }
  if (type === 'icmp') {
    const out = await runCmd(`ping -c 1 -W 1 ${target}`);
    return { status: out ? 'online' : 'offline', latencyMs: Date.now() - start, error: out ? null : 'icmp failed' };
  }
  return { status: 'unknown', latencyMs: null, error: `unsupported check type: ${type}` };
}

function upsertIncidentFromCheck(check, result) {
  const dedupKey = `service-check:${check.id}`;
  const openIncident = parseRows(db.exec(`SELECT * FROM incidents WHERE dedup_key = '${dedupKey}' AND status = 'open' LIMIT 1`))[0];
  const threshold = Number(check.threshold_failures || 3);
  const failureCount = Number(check.failure_count || 0);

  if (result.status !== 'online' && failureCount >= threshold) {
    if (!openIncident) {
      const stmt = db.prepare(`
        INSERT INTO incidents (dedup_key, source_type, source_id, severity, status, title, details, created_at, updated_at)
        VALUES (?, 'service_check', ?, 'warning', 'open', ?, ?, ?, ?)
      `);
      stmt.run([dedupKey, String(check.id), `${check.name} is degraded`, result.error || 'health check failed', nowIso(), nowIso()]);
      stmt.free();
    } else {
      const update = db.prepare("UPDATE incidents SET details = ?, updated_at = ? WHERE id = ?");
      update.run([result.error || 'health check failed', nowIso(), openIncident.id]);
      update.free();
    }
  }

  if (result.status === 'online' && openIncident) {
    const closeStmt = db.prepare("UPDATE incidents SET status = 'resolved', updated_at = ? WHERE id = ?");
    closeStmt.run([nowIso(), openIncident.id]);
    closeStmt.free();
  }
}

async function sendIncidentAlerts() {
  const channels = parseRows(db.exec("SELECT * FROM alert_channels WHERE enabled = 1"));
  if (!channels.length) return;

  const incidents = parseRows(db.exec(`
    SELECT * FROM incidents
    WHERE status = 'open'
      AND (alert_sent_at IS NULL)
      AND (silenced_until IS NULL OR silenced_until < '${nowIso()}')
    ORDER BY id ASC
    LIMIT 20
  `));
  for (const incident of incidents) {
    for (const channel of channels) {
      if (channel.type === 'webhook') {
        const payload = JSON.stringify({
          text: `[${incident.severity}] ${incident.title}: ${incident.details || ''}`.trim(),
          incidentId: incident.id,
        }).replace(/'/g, "'\\''");
        await runCmd(`curl -s -X POST -H 'Content-Type: application/json' -d '${payload}' '${String(channel.target).replace(/'/g, "'\\''")}'`);
      }
    }
    const mark = db.prepare("UPDATE incidents SET alert_sent_at = ?, updated_at = ? WHERE id = ?");
    mark.run([nowIso(), nowIso(), incident.id]);
    mark.free();
  }
  saveDB();
}

async function processServiceChecks() {
  const checks = parseRows(db.exec("SELECT * FROM service_checks WHERE enabled = 1"));
  for (const check of checks) {
    const dependencyIds = safeJsonParse(check.depends_on, []);
    if (Array.isArray(dependencyIds) && dependencyIds.length) {
      const blocked = dependencyIds.some((depId) => {
        const dep = parseRows(db.exec(`SELECT last_status FROM service_checks WHERE id = ${Number(depId)} LIMIT 1`))[0];
        return dep && dep.last_status !== 'online';
      });
      if (blocked) continue;
    }
    const result = await runServiceCheck(check);
    const nextFailureCount = result.status === 'online' ? 0 : Number(check.failure_count || 0) + 1;
    const stmt = db.prepare(`
      UPDATE service_checks
      SET last_status = ?, last_latency_ms = ?, failure_count = ?, last_checked_at = ?
      WHERE id = ?
    `);
    stmt.run([result.status, result.latencyMs, nextFailureCount, nowIso(), check.id]);
    stmt.free();

    upsertIncidentFromCheck({ ...check, failure_count: nextFailureCount }, result);
  }
  saveDB();
  await sendIncidentAlerts();
}

app.get('/api/agents', (req, res) => {
  const agents = getEnabledAgents().map((agent) => ({
    ...agent,
    capabilities: safeJsonParse(agent.capabilities, []),
  }));
  res.json({ agents });
});

app.post('/api/agents', (req, res) => {
  const meta = requestMeta(req);
  const { id, name, host, mode = 'ssh', capabilities = [], enabled = true } = req.body || {};
  if (!id || !name || !host) {
    return res.status(400).json({ error: 'id, name and host are required' });
  }
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO agents (id, name, host, mode, capabilities, enabled)
    VALUES (?, ?, ?, ?, ?, ?)
  `);
  stmt.run([id, name, host, mode, JSON.stringify(capabilities), enabled ? 1 : 0]);
  stmt.free();
  saveDB();
  writeAudit({ ...meta, action: 'agent.upsert', entityType: 'agent', entityId: id, diff: req.body });
  res.json({ success: true });
});

app.post('/api/actions/execute', (req, res) => {
  const meta = requestMeta(req);
  const { action, target = 'localhost', agentId = 'local-agent', dryRun = false, rollbackCommand = null, payload = {}, maxRetries = JOB_MAX_RETRIES_DEFAULT, timeoutMs = 30000 } = req.body || {};
  if (!action) return res.status(400).json({ error: 'action is required' });
  const jobId = insertJob({
    action,
    target,
    agentId,
    dryRun,
    rollbackCommand,
    payload,
    maxRetries,
    timeoutMs,
    createdBy: meta.actor,
    createdFrom: meta.sourceIp,
  });
  writeAudit({ ...meta, action: 'job.create', entityType: 'job', entityId: String(jobId), diff: req.body });
  saveDB();
  res.status(202).json({ success: true, jobId, status: 'pending' });
});

app.get('/api/jobs', (req, res) => {
  const limit = Number(req.query.limit || 100);
  const jobs = parseRows(db.exec(`SELECT * FROM jobs ORDER BY id DESC LIMIT ${limit}`)).map((job) => ({
    ...job,
    payload: safeJsonParse(job.payload, {}),
    dry_run: Number(job.dry_run) === 1,
  }));
  res.json({ jobs });
});

app.get('/api/jobs/:id', (req, res) => {
  const id = Number(req.params.id);
  const job = parseRows(db.exec(`SELECT * FROM jobs WHERE id = ${id} LIMIT 1`))[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json({ job: { ...job, payload: safeJsonParse(job.payload, {}), dry_run: Number(job.dry_run) === 1 } });
});

app.post('/api/jobs/:id/rollback', (req, res) => {
  const meta = requestMeta(req);
  const id = Number(req.params.id);
  const job = parseRows(db.exec(`SELECT * FROM jobs WHERE id = ${id} LIMIT 1`))[0];
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (!job.rollback_command) return res.status(400).json({ error: 'No rollback command available for this job' });

  const rollbackId = insertJob({
    action: `${job.action}.rollback`,
    target: job.target,
    agentId: job.agent_id,
    dryRun: false,
    rollbackOf: job.id,
    payload: { commandOverride: job.rollback_command },
    createdBy: meta.actor,
    createdFrom: meta.sourceIp,
  });
  writeAudit({ ...meta, action: 'job.rollback', entityType: 'job', entityId: String(rollbackId), diff: { rollbackOf: id } });
  saveDB();
  res.status(202).json({ success: true, rollbackJobId: rollbackId });
});

app.get('/api/service-checks', (req, res) => {
  const checks = parseRows(db.exec("SELECT * FROM service_checks ORDER BY id DESC")).map((row) => ({
    ...row,
    depends_on: safeJsonParse(row.depends_on, []),
    enabled: Number(row.enabled) === 1,
  }));
  res.json({ checks });
});

app.post('/api/service-checks', (req, res) => {
  const meta = requestMeta(req);
  const { name, target, checkType = 'http', thresholdFailures = 3, dependsOn = [], enabled = true } = req.body || {};
  if (!name || !target) return res.status(400).json({ error: 'name and target are required' });
  const stmt = db.prepare(`
    INSERT INTO service_checks (name, target, check_type, threshold_failures, depends_on, enabled, last_status)
    VALUES (?, ?, ?, ?, ?, ?, 'unknown')
  `);
  stmt.run([name, target, checkType, thresholdFailures, JSON.stringify(dependsOn), enabled ? 1 : 0]);
  stmt.free();
  const id = db.exec("SELECT last_insert_rowid() as id")[0].values[0][0];
  saveDB();
  writeAudit({ ...meta, action: 'service_check.create', entityType: 'service_check', entityId: String(id), diff: req.body });
  res.status(201).json({ success: true, id });
});

app.post('/api/service-checks/run', async (req, res) => {
  await processServiceChecks();
  const checks = parseRows(db.exec("SELECT * FROM service_checks ORDER BY id DESC LIMIT 200"));
  res.json({ success: true, checks });
});

app.get('/api/incidents', (req, res) => {
  const incidents = parseRows(db.exec("SELECT * FROM incidents ORDER BY id DESC LIMIT 500"));
  res.json({ incidents });
});

app.post('/api/incidents/:id/ack', (req, res) => {
  const meta = requestMeta(req);
  const id = Number(req.params.id);
  const { ack = true } = req.body || {};
  const stmt = db.prepare(`
    UPDATE incidents
    SET acknowledged_by = ?, acknowledged_at = ?, status = ?, updated_at = ?
    WHERE id = ?
  `);
  stmt.run([ack ? meta.actor : null, ack ? nowIso() : null, ack ? 'acknowledged' : 'open', nowIso(), id]);
  stmt.free();
  saveDB();
  writeAudit({ ...meta, action: ack ? 'incident.ack' : 'incident.unack', entityType: 'incident', entityId: String(id) });
  res.json({ success: true });
});

app.post('/api/incidents/:id/silence', (req, res) => {
  const meta = requestMeta(req);
  const id = Number(req.params.id);
  const minutes = Number(req.body?.minutes || 60);
  const until = new Date(Date.now() + minutes * 60 * 1000).toISOString();
  const stmt = db.prepare("UPDATE incidents SET silenced_until = ?, updated_at = ? WHERE id = ?");
  stmt.run([until, nowIso(), id]);
  stmt.free();
  saveDB();
  writeAudit({ ...meta, action: 'incident.silence', entityType: 'incident', entityId: String(id), diff: { until } });
  res.json({ success: true, silencedUntil: until });
});

app.get('/api/alerts/channels', (req, res) => {
  const channels = parseRows(db.exec("SELECT * FROM alert_channels ORDER BY id DESC"));
  res.json({ channels });
});

app.post('/api/alerts/channels', (req, res) => {
  const meta = requestMeta(req);
  const { type = 'webhook', target, enabled = true } = req.body || {};
  if (!target) return res.status(400).json({ error: 'target required' });
  const stmt = db.prepare("INSERT INTO alert_channels (type, target, enabled) VALUES (?, ?, ?)");
  stmt.run([type, target, enabled ? 1 : 0]);
  stmt.free();
  const id = db.exec("SELECT last_insert_rowid() as id")[0].values[0][0];
  saveDB();
  writeAudit({ ...meta, action: 'alert_channel.create', entityType: 'alert_channel', entityId: String(id), diff: req.body });
  res.status(201).json({ success: true, id });
});

app.get('/api/inventory/assets', (req, res) => {
  const assets = parseRows(db.exec("SELECT * FROM assets ORDER BY id DESC"));
  res.json({ assets: assets.map((asset) => ({ ...asset, tags: safeJsonParse(asset.tags, []) })) });
});

app.post('/api/inventory/assets', (req, res) => {
  const meta = requestMeta(req);
  const { hostname = null, ip = null, mac = null, owner = null, environment = 'prod', tags = [], source = 'manual', approved = true, status = 'active' } = req.body || {};
  const stmt = db.prepare(`
    INSERT INTO assets (hostname, ip, mac, owner, environment, tags, source, approved, status, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run([hostname, ip, mac, owner, environment, JSON.stringify(tags), source, approved ? 1 : 0, status, nowIso()]);
  stmt.free();
  const id = db.exec("SELECT last_insert_rowid() as id")[0].values[0][0];
  saveDB();
  writeAudit({ ...meta, action: 'asset.create', entityType: 'asset', entityId: String(id), diff: req.body });
  res.status(201).json({ success: true, id });
});

app.post('/api/inventory/import-lan', async (req, res) => {
  const meta = requestMeta(req);
  const subnet = String(req.body?.subnet || '192.168.1');
  const devices = await scanSubnet(subnet);
  const insert = db.prepare(`
    INSERT INTO inventory_approvals (ip, hostname, mac, source, status, requested_by)
    VALUES (?, ?, ?, 'lan_scan', 'pending', ?)
  `);
  devices.forEach((device) => insert.run([device.ip, device.hostname || null, device.mac || null, meta.actor]));
  insert.free();
  saveDB();
  writeAudit({ ...meta, action: 'inventory.import_lan', entityType: 'inventory_approval', entityId: subnet, diff: { count: devices.length } });
  res.json({ success: true, proposed: devices.length });
});

app.get('/api/inventory/approvals', (req, res) => {
  const approvals = parseRows(db.exec("SELECT * FROM inventory_approvals ORDER BY id DESC LIMIT 1000"));
  res.json({ approvals });
});

app.post('/api/inventory/approvals/:id/review', (req, res) => {
  const meta = requestMeta(req);
  const id = Number(req.params.id);
  const decision = String(req.body?.decision || '').toLowerCase();
  if (!['approved', 'rejected'].includes(decision)) {
    return res.status(400).json({ error: 'decision must be approved or rejected' });
  }
  const row = parseRows(db.exec(`SELECT * FROM inventory_approvals WHERE id = ${id} LIMIT 1`))[0];
  if (!row) return res.status(404).json({ error: 'approval item not found' });

  const reviewStmt = db.prepare(`
    UPDATE inventory_approvals
    SET status = ?, reviewed_by = ?, reviewed_at = ?
    WHERE id = ?
  `);
  reviewStmt.run([decision, meta.actor, nowIso(), id]);
  reviewStmt.free();

  if (decision === 'approved') {
    const assetStmt = db.prepare(`
      INSERT INTO assets (hostname, ip, mac, owner, environment, tags, source, approved, status, updated_at)
      VALUES (?, ?, ?, ?, 'prod', '[]', 'lan_scan', 1, 'active', ?)
    `);
    assetStmt.run([row.hostname || null, row.ip || null, row.mac || null, meta.actor, nowIso()]);
    assetStmt.free();
  }
  saveDB();
  writeAudit({ ...meta, action: `inventory.approval.${decision}`, entityType: 'inventory_approval', entityId: String(id) });
  res.json({ success: true });
});

app.get('/api/audit', (req, res) => {
  const limit = Number(req.query.limit || 200);
  const entries = parseRows(db.exec(`SELECT * FROM audit_log ORDER BY id DESC LIMIT ${limit}`)).map((entry) => ({
    ...entry,
    diff: safeJsonParse(entry.diff, entry.diff),
  }));
  res.json({ entries });
});

app.get('/api/secrets', (req, res) => {
  const secrets = parseRows(db.exec("SELECT id, name, created_at, updated_at FROM secrets ORDER BY id DESC"));
  res.json({ secrets });
});

app.post('/api/secrets', (req, res) => {
  const meta = requestMeta(req);
  const { name, value } = req.body || {};
  if (!name || !value) return res.status(400).json({ error: 'name and value required' });
  const enc = encryptSecret(value);
  const stmt = db.prepare(`
    INSERT INTO secrets (name, ciphertext, iv, tag, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET ciphertext = excluded.ciphertext, iv = excluded.iv, tag = excluded.tag, updated_at = excluded.updated_at
  `);
  stmt.run([name, enc.ciphertext, enc.iv, enc.tag, nowIso()]);
  stmt.free();
  saveDB();
  writeAudit({ ...meta, action: 'secret.upsert', entityType: 'secret', entityId: name });
  res.json({ success: true, name });
});

app.post('/api/secrets/:name/reveal', (req, res) => {
  const name = String(req.params.name);
  const secret = parseRows(db.exec(`SELECT * FROM secrets WHERE name = '${name.replace(/'/g, "''")}' LIMIT 1`))[0];
  if (!secret) return res.status(404).json({ error: 'secret not found' });
  try {
    const value = decryptSecret(secret);
    res.json({ name, value });
  } catch {
    res.status(500).json({ error: 'failed to decrypt secret' });
  }
});

// Start server
initDB().then(() => {
  setInterval(() => {
    processPendingJobs().catch((err) => console.error('job processor error', err));
  }, 1500);

  setInterval(() => {
    processServiceChecks().catch((err) => console.error('service check error', err));
  }, 60000);

  const PORT = 3001;
  app.listen(PORT, () => console.log(`HomeBoard API running on port ${PORT}`));
});

// Proxmox cluster stats endpoint with caching
let proxmoxCache = { data: null, timestamp: 0 };
const PROXMOX_CACHE_TTL = 15000; // 15 seconds

const PROXMOX_HOST = '192.168.1.199';
const PROXMOX_TOKEN_USER = 'root@pam!Netstat';
const PROXMOX_TOKEN_SECRET = 'a4f4b012-8211-4786-bf8e-51ccd1f3af3f';

const https = require('https');

async function proxmoxApiCall(endpoint, method = 'GET', body = null) {
  const url = `https://${PROXMOX_HOST}:8006/api2/json${endpoint}`;
  
  return new Promise((resolve, reject) => {
    const options = {
      headers: {
        'Authorization': `PVEAPIToken=${PROXMOX_TOKEN_USER}=${PROXMOX_TOKEN_SECRET}`,
        'Content-Type': 'application/json'
      },
      rejectUnauthorized: false,
      method: method
    };
    
    if (body) {
      options.headers['Content-Length'] = JSON.stringify(body).length;
    }
    
    const req = https.request(url, options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error('Invalid JSON response'));
        }
      });
    });
    
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

app.get('/api/proxmox', async (req, res) => {
  try {
    // Check cache first
    const now = Date.now();
    if (proxmoxCache.data && (now - proxmoxCache.timestamp) < PROXMOX_CACHE_TTL) {
      return res.json(proxmoxCache.data);
    }
    
    // Fetch cluster resources
    const clusterData = await proxmoxApiCall('/cluster/resources');
    
    // Fetch node status for beta (main node)
    let nodeStatus = null;
    try {
      const nodeData = await proxmoxApiCall('/nodes/beta/status');
      nodeStatus = nodeData.data;
    } catch (e) {
      console.log('Could not fetch node status:', e.message);
    }
    
    // Fetch storage
    const storageData = await proxmoxApiCall('/cluster/storage');
    
    // Parse storage
    const storage = (storageData.data || []).map(s => ({
      name: s.storage,
      type: s.type,
      total: s.total || 0,
      used: s.used || 0,
      available: (s.total || 0) - (s.used || 0),
      percent: s.total ? Math.round((s.used / s.total) * 100) : 0
    }));
    
    // Parse VMs and LXCs
    const resources = clusterData.data || [];
    const vms = resources
      .filter(r => r.type === 'qemu' || r.type === 'lxc')
      .map(r => ({
        vmid: String(r.vmid),
        status: r.status === 'running' ? 'running' : 'stopped',
        name: r.name || r.node,
        type: r.type
      }));
    
    const vmsRunning = vms.filter(v => v.status === 'running').length;
    const vmsStopped = vms.filter(v => v.status === 'stopped').length;
    
    // Build nodes with real-time status
    const nodes = [
      { 
        name: 'beta', 
        ip: '192.168.1.199', 
        status: 'online',
        cpu: nodeStatus?.cpu || 0,
        memory: nodeStatus?.memory ? {
          used: Math.round(nodeStatus.memory.used / 1024 / 1024 / 1024),
          total: Math.round(nodeStatus.memory.total / 1024 / 1024 / 1024),
          percent: Math.round((nodeStatus.memory.used / nodeStatus.memory.total) * 100)
        } : null,
        swap: nodeStatus?.swap ? {
          used: Math.round(nodeStatus.swap.used / 1024 / 1024 / 1024),
          total: Math.round(nodeStatus.swap.total / 1024 / 1024 / 1024),
          percent: Math.round((nodeStatus.swap.used / nodeStatus.swap.total) * 100)
        } : null,
        uptime: nodeStatus?.uptime || 0,
        disk: nodeStatus?.rootfs ? {
          used: Math.round(nodeStatus.rootfs.used / 1024 / 1024 / 1024),
          total: Math.round(nodeStatus.rootfs.total / 1024 / 1024 / 1024),
          percent: Math.round((nodeStatus.rootfs.used / nodeStatus.rootfs.total) * 100)
        } : null,
        loadavg: nodeStatus?.loadavg || [],
        cpuModel: nodeStatus?.cpuinfo?.model || '',
        cpuCores: nodeStatus?.cpuinfo?.cpus || 0,
        cpuSockets: nodeStatus?.cpuinfo?.sockets || 0,
        cpuMhz: nodeStatus?.cpuinfo?.mhz || 0,
        kernel: nodeStatus?.['current-kernel']?.release || '',
        pveVersion: nodeStatus?.pveversion || '',
        bootMode: nodeStatus?.['bootinfo']?.mode || ''
      },
      { name: 'alpha', ip: '192.168.1.91', status: 'offline' },
      { name: 'gamma', ip: '192.168.1.92', status: 'offline' }
    ];
    
    const result = {
      nodes,
      storage,
      vms: {
        total: vms.length,
        running: vmsRunning,
        stopped: vmsStopped,
        list: vms
      },
      timestamp: new Date().toISOString()
    };
    
    // Update cache
    proxmoxCache = { data: result, timestamp: Date.now() };
    
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get LXC/VM details endpoint
app.get('/api/proxmox/vm/:vmid', async (req, res) => {
  try {
    const { vmid } = req.params;
    
    // First check if it's LXC or QEMU and get the node
    const clusterData = await proxmoxApiCall('/cluster/resources');
    const vmInfo = (clusterData.data || []).find(r => String(r.vmid) === vmid);
    const vmType = vmInfo?.type || 'lxc';
    const nodeName = vmInfo?.node || 'beta';
    
    let config, status;
    
    if (vmType === 'lxc') {
      const configData = await proxmoxApiCall(`/nodes/${nodeName}/lxc/${vmid}/config`);
      const statusData = await proxmoxApiCall(`/nodes/${nodeName}/lxc/${vmid}/status/current`);
      config = configData.data || {};
      status = statusData.data || {};
    } else {
      const configData = await proxmoxApiCall(`/nodes/${nodeName}/qemu/${vmid}/config`);
      const statusData = await proxmoxApiCall(`/nodes/${nodeName}/qemu/${vmid}/status/current`);
      config = configData.data || {};
      status = statusData.data || {};
    }
    
    // Extract IP from tags or network config
    let ipAddress = '';
    const tags = config.tags || '';
    const ipMatch = tags.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
    if (ipMatch) {
      ipAddress = ipMatch[1];
    } else if (config.net0) {
      // Try to extract IP from net0 config (bridge=vmbr0,ip=dhcp or ip=10.0.0.1/24)
      const netIpMatch = config.net0.match(/ip=([^,]+)/);
      if (netIpMatch && !netIpMatch[1].includes('dhcp')) {
        ipAddress = netIpMatch[1].split('/')[0];
      }
    }
    
    // Build config object
    const configObj = {
      arch: config.arch || 'amd64',
      cores: config.cores || status.cpus || '2',
      description: config.description || '',
      hostname: config.hostname || '',
      memory: config.memory || status.maxmem ? Math.round(Number(status.maxmem) / 1024 / 1024) : '512',
      net0: config.net0 || '',
      onboot: config.onboot ? '1' : '0',
      ostype: config.ostype || '',
      rootfs: config.rootfs || '',
      swap: config.swap || '512',
      tags: config.tags || '',
      unprivileged: config.unprivileged ? '1' : '0',
      ipAddress: ipAddress
    };
    
    // Build real-time status object
    const statusObj = {
      status: status.status || 'unknown',
      cpu: status.cpu || 0,
      memory: {
        used: status.mem ? Math.round(Number(status.mem) / 1024 / 1024) : 0,
        total: status.maxmem ? Math.round(Number(status.maxmem) / 1024 / 1024) : parseInt(configObj.memory),
        percent: status.maxmem && status.mem ? Math.round((Number(status.mem) / Number(status.maxmem)) * 100) : 0
      },
      uptime: status.uptime || 0,
      disk: {
        used: status.disk ? Math.round(Number(status.disk) / 1024 / 1024) : 0,
        total: status.maxdisk ? Math.round(Number(status.maxdisk) / 1024 / 1024) : 0,
        percent: status.maxdisk && status.disk ? Math.round((Number(status.disk) / Number(status.maxdisk)) * 100) : 0
      },
      network: {
        in: status.netin ? Math.round(Number(status.netin) / 1024) : 0,
        out: status.netout ? Math.round(Number(status.netout) / 1024) : 0
      }
    };
    
    res.json({
      vmid: parseInt(vmid),
      config: configObj,
      status: statusObj,
      storage: '',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VM Execute Command - specific route first
app.post('/api/proxmox/vm/:vmid/exec', async (req, res) => {
  try {
    const { vmid } = req.params;
    const { command } = req.body;
    
    if (!command) {
      return res.status(400).json({ error: 'Command is required' });
    }
    
    // Get VM type and node
    const clusterData = await proxmoxApiCall('/cluster/resources');
    const vmInfo = (clusterData.data || []).find(r => String(r.vmid) === vmid);
    const vmType = vmInfo?.type || 'lxc';
    const nodeName = vmInfo?.node || 'beta';
    
    // Execute command in LXC
    let output;
    if (vmType === 'lxc') {
      output = await proxmoxApiCall(`/nodes/${nodeName}/${vmType}/${vmid}/exec`, 'POST', {
        command: command,
        stdin: 0
      });
    } else {
      output = { output: 'QEMU console requires SPICE or VNC - check Proxmox web UI' };
    }
    
    res.json({ 
      success: true, 
      output: output?.data?.output || output?.output || JSON.stringify(output),
      vmid: parseInt(vmid)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// VM Actions - Start/Stop/Reboot
app.post('/api/proxmox/vm/:vmid/:action', async (req, res) => {
  try {
    const { vmid, action } = req.params;
    
    if (!['start', 'stop', 'restart', 'suspend', 'resume'].includes(action)) {
      return res.status(400).json({ error: 'Invalid action' });
    }
    
    // Get VM type
    const clusterData = await proxmoxApiCall('/cluster/resources');
    const vmInfo = (clusterData.data || []).find(r => String(r.vmid) === vmid);
    const vmType = vmInfo?.type || 'lxc';
    const nodeName = vmInfo?.node || 'beta';
    
    // For stop, we use shutdown for LXC, stop for QEMU
    let apiAction = action;
    if (vmType === 'lxc' && action === 'stop') {
      apiAction = 'shutdown';
    }
    
    const result = await proxmoxApiCall(`/nodes/${nodeName}/${vmType}/${vmid}/status/${apiAction}`, 'POST');
    
    res.json({ success: true, action, vmid: parseInt(vmid), result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Port scan cache
const portScanCache = { data: null, timestamp: 0 }
const PORT_SCAN_TTL = 300000 // 5 minutes

// Port scan for LXC containers - uses existing /api/ports/:ip
app.get('/api/proxmox/ports', async (req, res) => {
  try {
    const force = req.query.force === 'true'
    const now = Date.now()
    
    // Return cached if valid
    if (!force && portScanCache.data && (now - portScanCache.timestamp) < PORT_SCAN_TTL) {
      return res.json(portScanCache.data)
    }
    
    // Get cluster resources with network info
    const clusterData = await proxmoxApiCall('/cluster/resources')
    const vms = (clusterData.data || []).filter(r => r.type === 'lxc' && r.status === 'running')
    
    const results = await Promise.all(vms.map(async (vm) => {
      // Try to get IP from multiple sources
      let ip = vm.ip || null
      
      // If no direct IP, try to get from tags (format: "ip;description;category")
      if (!ip && vm.tags) {
        const tagParts = vm.tags.split(';')
        for (const part of tagParts) {
          if (/^\d{1,3}(\.\d{1,3}){3}$/.test(part)) {
            ip = part
            break
          }
        }
      }
      
      // If still no IP, try to get from config
      if (!ip) {
        try {
          const configData = await proxmoxApiCall(`/nodes/${vm.node}/lxc/${vm.vmid}/config`)
          const config = configData.data || {}
          const net0 = config.net0 || ''
          const ipMatch = net0.match(/ip=(\d+\.\d+\.\d+\.\d+\/\d+)/)
          if (ipMatch) {
            ip = ipMatch[1].split('/')[0]
          }
        } catch { /* ignore */ }
      }
      
      if (!ip) {
        return { vmid: vm.vmid, name: vm.name, ip: null, ports: [] }
      }
      
      // Scan all ports 1-9999 with parallel connections
      const allPorts = Array.from({ length: 9999 }, (_, i) => i + 1)
      const timeout = 500 // 500ms timeout per port
      const concurrency = 100 // Parallel connections
      
      const openPorts = []
      for (let i = 0; i < allPorts.length; i += concurrency) {
        const batch = allPorts.slice(i, i + concurrency)
        const results = await Promise.all(batch.map(async (port) => {
          try {
            return await new Promise((resolve) => {
              const sock = require('net').createConnection({ host: ip, port, timeout })
              sock.on('connect', () => { sock.destroy(); resolve(port); })
              sock.on('error', () => { sock.destroy(); resolve(null); })
              sock.on('timeout', () => { sock.destroy(); resolve(null); })
            })
          } catch { return null }
        }))
        openPorts.push(...results.filter(Boolean))
      }
      const ports = openPorts.sort((a, b) => a - b)
      return { vmid: vm.vmid, name: vm.name, ip, ports }
    }))
    
    portScanCache.data = { vms: results, timestamp: new Date().toISOString() }
    portScanCache.timestamp = now
    
    res.json(portScanCache.data)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})
