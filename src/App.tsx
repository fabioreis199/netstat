import { useEffect, useMemo, useState } from 'react'
import {
  Activity,
  Container,
  Cpu,
  HardDrive,
  ExternalLink,
  Moon,
  Play,
  RefreshCw,
  Server,
  Square,
  Sun,
  Terminal,
  Wifi,
  WifiOff,
} from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Dialog } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Progress } from '@/components/ui/progress'
import { Select } from '@/components/ui/select'
import { Separator } from '@/components/ui/separator'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

interface Node {
  name: string
  ip: string
  status: 'online' | 'offline'
  cpu?: number
  memory?: { used: number; total: number; percent: number }
  disk?: { used: number; total: number; percent: number }
  loadavg?: string[]
  uptime?: number
  kernel?: string
}

interface Storage {
  name: string
  type: string
  total: number
  used: number
  available: number
  percent: number
}

interface VM {
  vmid: string
  status: 'running' | 'stopped'
  name: string
  type?: 'qemu' | 'lxc'
}

interface ProxmoxData {
  nodes: Node[]
  storage: Storage[]
  vms: {
    total: number
    running: number
    stopped: number
    list: VM[]
  }
  timestamp: string
}

interface VMDetails {
  vmid: string
  openPorts?: number[]
  config: {
    hostname?: string
    memory?: string
    cores?: string
    ostype?: string
    net0?: string
    ipAddress?: string
    description?: string
    openPorts?: number[] | string
  }
  status: {
    status?: string
    cpu?: number
    memory?: { used: number; total: number; percent: number }
    uptime?: number
  }
}

const API_BASE = 'http://192.168.1.57:3001/api/proxmox'

function statusVariant(status: string) {
  if (status === 'running' || status === 'online') return 'success' as const
  return 'danger' as const
}

function formatUptime(seconds?: number): string {
  if (!seconds) return '-'
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const mins = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${mins}m`
  return `${mins}m`
}

function formatBytes(bytes?: number): string {
  if (!bytes || bytes <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`
}

function sanitizeDescriptionHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/\son\w+="[^"]*"/gi, '')
    .replace(/\son\w+='[^']*'/gi, '')
    .replace(/javascript:/gi, '')
}

function normalizeOpenPorts(raw: unknown): number[] {
  if (!raw) return []
  if (Array.isArray(raw)) {
    return raw
      .map((p) => Number(p))
      .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
  }
  if (typeof raw === 'string') {
    return raw
      .split(/[\s,;|]+/)
      .map((p) => Number(p.trim()))
      .filter((p) => Number.isInteger(p) && p > 0 && p <= 65535)
  }
  return []
}

export default function App() {
  const [data, setData] = useState<ProxmoxData | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const [vmSearch, setVmSearch] = useState('')
  const [vmStatus, setVmStatus] = useState<'all' | 'running' | 'stopped'>('all')
  const [vmType, setVmType] = useState<'all' | 'lxc' | 'qemu'>('all')
  const [storageSearch, setStorageSearch] = useState('')

  const [selectedNode, setSelectedNode] = useState<Node | null>(null)
  const [selectedStorage, setSelectedStorage] = useState<Storage | null>(null)
  const [selectedVM, setSelectedVM] = useState<VMDetails | null>(null)
  const [vmDetailLoading, setVmDetailLoading] = useState(false)
  const [isDark, setIsDark] = useState(false)

  // Port scanning
  const [ports, setPorts] = useState<{ vmid: string; name: string; ip: string; ports: number[] }[]>([])
  const [portDataLoading, setPortDataLoading] = useState(false)
  const [selectedPortVM, setSelectedPortVM] = useState<{ vmid: string; name: string; ip: string; ports: number[] } | null>(null)

  async function fetchPorts() {
    setPortDataLoading(true)
    try {
      const res = await fetch(`${API_BASE}/ports`)
      if (!res.ok) throw new Error('Failed to fetch ports')
      const json = (await res.json()) as { vms: { vmid: string; name: string; ip: string; ports: number[] }[] }
      setPorts(json.vms.filter((v) => v.ports.length > 0))
    } catch (e) {
      console.error('Port scan error:', e)
    } finally {
      setPortDataLoading(false)
    }
  }

  async function fetchData() {
    try {
      const res = await fetch(API_BASE)
      if (!res.ok) throw new Error('Failed to fetch data')
      const json = (await res.json()) as ProxmoxData
      setData(json)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setLoading(false)
    }
  }

  async function fetchVMDetails(vmid: string) {
    setVmDetailLoading(true)
    setSelectedVM({ vmid, config: {}, status: {} })
    try {
      const res = await fetch(`${API_BASE}/vm/${vmid}`)
      if (!res.ok) throw new Error('Failed to fetch VM details')
      const json = (await res.json()) as VMDetails & { ports?: unknown }
      const ports = normalizeOpenPorts(json.openPorts ?? json.config?.openPorts ?? json.ports)
      setSelectedVM({ ...json, openPorts: ports })
    } catch {
      setSelectedVM({ vmid, config: {}, status: {} })
    } finally {
      setVmDetailLoading(false)
    }
  }

  async function handleVMAction(vmid: string, action: 'start' | 'stop' | 'restart') {
    const accepted = confirm(`Are you sure you want to ${action} VM ${vmid}?`)
    if (!accepted) return
    try {
      const res = await fetch(`${API_BASE}/vm/${vmid}/${action}`, { method: 'POST' })
      if (!res.ok) throw new Error('Action failed')
      await fetchData()
      if (selectedVM?.vmid === vmid) fetchVMDetails(vmid)
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Action failed')
    }
  }

  async function handleOpenVmIp(vmid: string) {
    try {
      const res = await fetch(`${API_BASE}/vm/${vmid}`)
      if (!res.ok) throw new Error('Failed to fetch VM details')
      const vm = (await res.json()) as VMDetails
      const ip = vm.config.ipAddress?.trim()
      if (!ip) {
        alert(`No IP address available for VM ${vmid}`)
        return
      }
      const url = ip.startsWith('http://') || ip.startsWith('https://') ? ip : `http://${ip}`
      window.open(url, '_blank', 'noopener,noreferrer')
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Failed to open VM IP')
    }
  }

  useEffect(() => {
    const saved = localStorage.getItem('theme')
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
    const nextDark = saved ? saved === 'dark' : prefersDark
    setIsDark(nextDark)
    document.documentElement.classList.toggle('dark', nextDark)
  }, [])

  useEffect(() => {
    fetchData()
    const timer = setInterval(fetchData, 30000)
    fetchPorts() // Initial port scan
    return () => clearInterval(timer)
  }, [])

  function toggleTheme() {
    const next = !isDark
    setIsDark(next)
    document.documentElement.classList.toggle('dark', next)
    localStorage.setItem('theme', next ? 'dark' : 'light')
  }

  const filteredVms = useMemo(() => {
    const list = data?.vms.list ?? []
    return list.filter((vm) => {
      const matchesSearch = vm.name.toLowerCase().includes(vmSearch.toLowerCase()) || vm.vmid.includes(vmSearch)
      const matchesStatus = vmStatus === 'all' || vm.status === vmStatus
      const matchesType = vmType === 'all' || vm.type === vmType
      return matchesSearch && matchesStatus && matchesType
    })
  }, [data?.vms.list, vmSearch, vmStatus, vmType])

  const filteredStorage = useMemo(() => {
    const list = data?.storage ?? []
    return list
      .filter((s) => s.total > 0)
      .filter((s) => s.name.toLowerCase().includes(storageSearch.toLowerCase()))
  }, [data?.storage, storageSearch])

  if (loading) {
    return (
      <main className='grid min-h-screen place-items-center bg-zinc-50 dark:bg-zinc-950'>
        <div className='flex items-center gap-2 text-zinc-600 dark:text-zinc-300'>
          <Activity className='h-5 w-5 animate-spin' /> Loading cluster data...
        </div>
      </main>
    )
  }

  if (error) {
    return (
      <main className='grid min-h-screen place-items-center bg-zinc-50 p-6 dark:bg-zinc-950'>
        <Card className='max-w-md'>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-red-700'>
              <WifiOff className='h-5 w-5' /> Connection Error
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
          <CardContent>
            <Button onClick={fetchData}>Retry</Button>
          </CardContent>
        </Card>
      </main>
    )
  }

  if (!data) return null

  return (
    <main className='min-h-screen bg-[radial-gradient(circle_at_15%_20%,#dbeafe_0,#f8fafc_38%,#f8fafc_100%)] text-zinc-900 dark:bg-[radial-gradient(circle_at_15%_20%,#1e293b_0,#09090b_45%,#09090b_100%)] dark:text-zinc-100'>
      <div className='mx-auto max-w-7xl space-y-6 p-4 pb-10 sm:p-6'>
        <header className='sticky top-0 z-20 rounded-xl border border-zinc-200/70 bg-white/85 p-4 backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-950/80'>
          <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
            <div className='flex items-center gap-3'>
              <div className='grid h-10 w-10 place-items-center rounded-xl bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'>
                <Server className='h-5 w-5' />
              </div>
              <div>
                <h1 className='text-xl font-semibold tracking-tight sm:text-2xl'>Proxmox Fleet Control</h1>
                <p className='text-xs text-zinc-500 sm:text-sm dark:text-zinc-400'>Last update {new Date(data.timestamp).toLocaleString()}</p>
              </div>
            </div>
            <div className='flex items-center gap-2'>
              <Button variant='outline' size='icon' onClick={toggleTheme} aria-label='Toggle theme'>
                {isDark ? <Sun className='h-4 w-4' /> : <Moon className='h-4 w-4' />}
              </Button>
              <Button variant='outline' onClick={fetchData}>
                <RefreshCw className='h-4 w-4' /> Refresh
              </Button>
            </div>
          </div>
        </header>

        <section className='grid grid-cols-2 gap-3 lg:grid-cols-4'>
          <Card>
            <CardContent className='pt-5'>
              <p className='text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400'>Nodes Online</p>
              <p className='mt-2 text-2xl font-semibold'>{data.nodes.filter((n) => n.status === 'online').length}/{data.nodes.length}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className='pt-5'>
              <p className='text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400'>Running VMs</p>
              <p className='mt-2 text-2xl font-semibold'>{data.vms.running}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className='pt-5'>
              <p className='text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400'>Stopped VMs</p>
              <p className='mt-2 text-2xl font-semibold'>{data.vms.stopped}</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className='pt-5'>
              <p className='text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400'>Storage Pools</p>
              <p className='mt-2 text-2xl font-semibold'>{data.storage.filter((s) => s.total > 0).length}</p>
            </CardContent>
          </Card>
        </section>

        <section className='grid gap-4 lg:grid-cols-3'>
          <Card className='lg:col-span-2'>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <Wifi className='h-4 w-4' /> Nodes
              </CardTitle>
            </CardHeader>
            <CardContent className='grid gap-3 sm:grid-cols-2'>
              {data.nodes.map((node) => (
                <button
                  key={node.name}
                  onClick={() => setSelectedNode(node)}
                  className='rounded-lg border border-zinc-200 p-4 text-left transition hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600'
                >
                  <div className='mb-3 flex items-center justify-between'>
                    <div>
                      <p className='font-medium'>{node.name}</p>
                      <p className='text-xs text-zinc-500 dark:text-zinc-400'>{node.ip}</p>
                    </div>
                    <Badge variant={statusVariant(node.status)}>{node.status}</Badge>
                  </div>
                  {node.status === 'online' && (
                    <div className='space-y-2'>
                      <div>
                        <div className='mb-1 flex justify-between text-xs text-zinc-500 dark:text-zinc-400'><span>CPU</span><span>{((node.cpu ?? 0) * 100).toFixed(1)}%</span></div>
                        <Progress value={(node.cpu ?? 0) * 100} />
                      </div>
                      <div>
                        <div className='mb-1 flex justify-between text-xs text-zinc-500 dark:text-zinc-400'><span>Memory</span><span>{node.memory?.percent ?? 0}%</span></div>
                        <Progress value={node.memory?.percent ?? 0} indicatorClassName='bg-blue-600' />
                      </div>
                    </div>
                  )}
                </button>
              ))}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle className='flex items-center gap-2'>
                <HardDrive className='h-4 w-4' /> Storage
              </CardTitle>
              <Input value={storageSearch} onChange={(e) => setStorageSearch(e.target.value)} placeholder='Search pool...' />
            </CardHeader>
            <CardContent className='space-y-3'>
              {filteredStorage.slice(0, 6).map((pool) => (
                <button
                  key={pool.name}
                  onClick={() => setSelectedStorage(pool)}
                  className='w-full rounded-lg border border-zinc-200 p-3 text-left hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600'
                >
                  <div className='mb-2 flex items-center justify-between'>
                    <span className='font-medium'>{pool.name}</span>
                    <Badge variant='secondary'>{pool.type}</Badge>
                  </div>
                  <Progress
                    value={pool.percent}
                    indicatorClassName={pool.percent > 85 ? 'bg-red-600' : pool.percent > 70 ? 'bg-amber-500' : 'bg-emerald-600'}
                  />
                  <p className='mt-2 text-xs text-zinc-500 dark:text-zinc-400'>{pool.percent}% used</p>
                </button>
              ))}
            </CardContent>
          </Card>

          {/* Ports Card */}
          <Card>
            <CardHeader>
              <div className='flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between'>
                <CardTitle className='flex items-center gap-2'>
                  <Wifi className='h-4 w-4' /> Open Ports
                </CardTitle>
                <div className='flex gap-2'>
                  <Button size='sm' variant='outline' onClick={() => fetchPorts()}>
                    <RefreshCw className='mr-2 h-4 w-4' /> Refresh
                  </Button>
                </div>
              </div>
            </CardHeader>
            <CardContent className='space-y-3'>
              {portDataLoading ? (
                <div className='flex items-center gap-2 text-zinc-500'>
                  <Activity className='h-4 w-4 animate-spin' /> Scanning...
                </div>
              ) : ports.length === 0 ? (
                <p className='text-sm text-zinc-500'>No open ports found</p>
              ) : (
                ports.slice(0, 12).map((vm) => (
                  <button
                    key={vm.vmid}
                    onClick={() => setSelectedPortVM(vm)}
                    className='w-full rounded-lg border border-zinc-200 p-3 text-left hover:border-zinc-400 dark:border-zinc-800 dark:hover:border-zinc-600'
                  >
                    <div className='flex items-center justify-between'>
                      <span className='font-medium'>{vm.name}</span>
                      <Badge variant='outline'>{vm.ip}</Badge>
                    </div>
                    <div className='mt-2 flex flex-wrap gap-1'>
                      {vm.ports.map((port) => (
                        <Badge key={port} variant='secondary' className='text-xs'>
                          {port}
                        </Badge>
                      ))}
                    </div>
                  </button>
                ))
              )}
            </CardContent>
          </Card>
        </section>

        <Card>
          <CardHeader>
            <div className='flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between'>
              <CardTitle className='flex items-center gap-2'>
                <Cpu className='h-4 w-4' /> Virtual Machines
              </CardTitle>
              <div className='grid grid-cols-1 gap-2 sm:grid-cols-3'>
                <Input value={vmSearch} onChange={(e) => setVmSearch(e.target.value)} placeholder='Search by name or ID...' />
                <Select value={vmType} onChange={(e) => setVmType(e.target.value as 'all' | 'lxc' | 'qemu')}>
                  <option value='all'>All types</option>
                  <option value='lxc'>LXC</option>
                  <option value='qemu'>QEMU</option>
                </Select>
                <Select value={vmStatus} onChange={(e) => setVmStatus(e.target.value as 'all' | 'running' | 'stopped')}>
                  <option value='all'>All status</option>
                  <option value='running'>Running</option>
                  <option value='stopped'>Stopped</option>
                </Select>
              </div>
            </div>
          </CardHeader>

          <CardContent>
            <div className='hidden overflow-x-auto md:block'>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Type</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className='text-right'>Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {filteredVms.map((vm) => (
                    <TableRow key={vm.vmid}>
                      <TableCell className='font-mono text-xs'>{vm.vmid}</TableCell>
                      <TableCell>
                        <button className='font-medium hover:underline' onClick={() => fetchVMDetails(vm.vmid)}>{vm.name}</button>
                      </TableCell>
                      <TableCell>
                        <span className='inline-flex items-center gap-1 text-xs text-zinc-600 dark:text-zinc-300'>
                          <Container className='h-3.5 w-3.5' /> {(vm.type ?? 'lxc').toUpperCase()}
                        </span>
                      </TableCell>
                      <TableCell><Badge variant={statusVariant(vm.status)}>{vm.status}</Badge></TableCell>
                      <TableCell className='space-x-1 text-right'>
                        {vm.status === 'running' ? (
                          <>
                            <Button size='sm' variant='destructive' onClick={() => handleVMAction(vm.vmid, 'stop')}><Square className='h-3.5 w-3.5' /></Button>
                            <Button size='sm' variant='secondary' onClick={() => handleVMAction(vm.vmid, 'restart')}><RefreshCw className='h-3.5 w-3.5' /></Button>
                          </>
                        ) : (
                          <Button size='sm' onClick={() => handleVMAction(vm.vmid, 'start')}><Play className='h-3.5 w-3.5' /></Button>
                        )}
                        <Button size='sm' variant='outline' onClick={() => fetchVMDetails(vm.vmid)}><Terminal className='h-3.5 w-3.5' /></Button>
                        <Button size='sm' variant='outline' onClick={() => handleOpenVmIp(vm.vmid)}><ExternalLink className='h-3.5 w-3.5' /></Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            <div className='space-y-2 md:hidden'>
              {filteredVms.map((vm) => (
                <div key={vm.vmid} className='rounded-lg border border-zinc-200 p-3 dark:border-zinc-800'>
                  <div className='mb-2 flex items-center justify-between'>
                    <div>
                      <p className='font-medium'>{vm.name}</p>
                      <p className='font-mono text-xs text-zinc-500 dark:text-zinc-400'>{vm.vmid}</p>
                    </div>
                    <Badge variant={statusVariant(vm.status)}>{vm.status}</Badge>
                  </div>
                  <div className='flex gap-2'>
                    {vm.status === 'running' ? (
                      <>
                        <Button size='sm' variant='destructive' onClick={() => handleVMAction(vm.vmid, 'stop')}>Stop</Button>
                        <Button size='sm' variant='secondary' onClick={() => handleVMAction(vm.vmid, 'restart')}>Restart</Button>
                      </>
                    ) : (
                      <Button size='sm' onClick={() => handleVMAction(vm.vmid, 'start')}>Start</Button>
                    )}
                    <Button size='sm' variant='outline' onClick={() => fetchVMDetails(vm.vmid)}>Details</Button>
                    <Button size='sm' variant='outline' onClick={() => handleOpenVmIp(vm.vmid)}>Open IP</Button>
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>

      <Dialog open={!!selectedNode} onClose={() => setSelectedNode(null)} title={`Node ${selectedNode?.name ?? ''}`}>
        {selectedNode && (
          <div className='space-y-3 text-sm'>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
              <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Status</p><p>{selectedNode.status}</p></CardContent></Card>
              <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>IP</p><p>{selectedNode.ip}</p></CardContent></Card>
              <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Kernel</p><p>{selectedNode.kernel ?? '-'}</p></CardContent></Card>
              <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Uptime</p><p>{formatUptime(selectedNode.uptime)}</p></CardContent></Card>
            </div>
            <Separator />
            <div className='space-y-2'>
              <p><strong>Load Average:</strong> {selectedNode.loadavg?.join(', ') || '-'}</p>
              <div>
                <div className='mb-1 flex justify-between text-xs text-zinc-500 dark:text-zinc-400'>
                  <span>CPU</span>
                  <span>{((selectedNode.cpu ?? 0) * 100).toFixed(1)}%</span>
                </div>
                <Progress value={(selectedNode.cpu ?? 0) * 100} />
              </div>
              <div>
                <div className='mb-1 flex justify-between text-xs text-zinc-500 dark:text-zinc-400'>
                  <span>Memory</span>
                  <span>{selectedNode.memory?.percent ?? 0}% ({selectedNode.memory?.used ?? 0}/{selectedNode.memory?.total ?? 0} GB)</span>
                </div>
                <Progress value={selectedNode.memory?.percent ?? 0} indicatorClassName='bg-blue-600' />
              </div>
              <div>
                <div className='mb-1 flex justify-between text-xs text-zinc-500 dark:text-zinc-400'>
                  <span>Disk</span>
                  <span>{selectedNode.disk?.percent ?? 0}% ({selectedNode.disk?.used ?? 0}/{selectedNode.disk?.total ?? 0} GB)</span>
                </div>
                <Progress value={selectedNode.disk?.percent ?? 0} indicatorClassName='bg-amber-500' />
              </div>
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={!!selectedStorage} onClose={() => setSelectedStorage(null)} title={`Storage ${selectedStorage?.name ?? ''}`}>
        {selectedStorage && (
          <div className='space-y-3 text-sm'>
            <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
              <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Type</p><p className='uppercase'>{selectedStorage.type}</p></CardContent></Card>
              <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Used</p><p>{formatBytes(selectedStorage.used)}</p></CardContent></Card>
              <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Available</p><p>{formatBytes(selectedStorage.available)}</p></CardContent></Card>
              <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Total</p><p>{formatBytes(selectedStorage.total)}</p></CardContent></Card>
            </div>
            <Separator />
            <div>
              <div className='mb-1 flex justify-between text-xs text-zinc-500 dark:text-zinc-400'>
                <span>Utilization</span>
                <span>{selectedStorage.percent}%</span>
              </div>
              <Progress
                value={selectedStorage.percent}
                indicatorClassName={selectedStorage.percent > 85 ? 'bg-red-600' : selectedStorage.percent > 70 ? 'bg-amber-500' : 'bg-emerald-600'}
              />
            </div>
          </div>
        )}
      </Dialog>

      <Dialog open={!!selectedVM} onClose={() => setSelectedVM(null)} title={`VM ${selectedVM?.vmid ?? ''}`}>
        {vmDetailLoading ? (
          <div className='flex items-center gap-2 text-sm text-zinc-600 dark:text-zinc-300'><Activity className='h-4 w-4 animate-spin' /> Loading details...</div>
        ) : (
          selectedVM && (
            <div className='space-y-3 text-sm'>
              <div className='grid grid-cols-2 gap-2 sm:grid-cols-4'>
                <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Status</p><p>{selectedVM.status.status ?? '-'}</p></CardContent></Card>
                <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Uptime</p><p>{formatUptime(selectedVM.status.uptime)}</p></CardContent></Card>
                <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>CPU</p><p>{(((selectedVM.status.cpu ?? 0) * 100)).toFixed(1)}%</p></CardContent></Card>
                <Card><CardContent className='pt-4'><p className='text-xs text-zinc-500 dark:text-zinc-400'>Memory</p><p>{selectedVM.status.memory?.percent ?? 0}%</p></CardContent></Card>
              </div>
              <Separator />
              <div className='grid gap-2 sm:grid-cols-2'>
                <p><strong>Hostname:</strong> {selectedVM.config.hostname ?? '-'}</p>
                <p><strong>OS:</strong> {selectedVM.config.ostype ?? '-'}</p>
                <p><strong>Cores:</strong> {selectedVM.config.cores ?? '-'}</p>
                <p><strong>Configured RAM:</strong> {selectedVM.config.memory ?? '-'} MB</p>
                <p>
                  <strong>IP:</strong>{' '}
                  {selectedVM.config.ipAddress ? (
                    <a
                      href={`http://${selectedVM.config.ipAddress}`}
                      target='_blank'
                      rel='noreferrer noopener'
                      className='text-blue-600 underline-offset-2 hover:underline dark:text-blue-400'
                    >
                      {selectedVM.config.ipAddress}
                    </a>
                  ) : (
                    '-'
                  )}
                </p>
                <p><strong>Network:</strong> {selectedVM.config.net0 ?? '-'}</p>
              </div>
              <div>
                <p className='mb-2 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400'>Open Ports</p>
                {selectedVM.config.ipAddress && (selectedVM.openPorts?.length ?? 0) > 0 ? (
                  <div className='flex flex-wrap gap-2'>
                    {selectedVM.openPorts?.map((port) => (
                      <a
                        key={port}
                        href={`http://${selectedVM.config.ipAddress}:${port}`}
                        target='_blank'
                        rel='noreferrer noopener'
                        className='rounded-md border border-zinc-200 px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800'
                      >
                        {port}
                      </a>
                    ))}
                  </div>
                ) : (
                  <p className='text-zinc-600 dark:text-zinc-300'>No open ports returned by API.</p>
                )}
              </div>
              {selectedVM.status.memory && (
                <div>
                  <div className='mb-1 flex justify-between text-xs text-zinc-500 dark:text-zinc-400'>
                    <span>Live Memory</span>
                    <span>{formatBytes(selectedVM.status.memory.used)} / {formatBytes(selectedVM.status.memory.total)}</span>
                  </div>
                  <Progress value={selectedVM.status.memory.percent} indicatorClassName='bg-blue-600' />
                </div>
              )}
              {selectedVM.config.description && (
                <>
                  <Separator />
                  <div>
                    <p className='mb-1 text-xs font-medium uppercase tracking-wide text-zinc-500 dark:text-zinc-400'>Description</p>
                    <div
                      className='prose prose-sm max-w-none text-zinc-700 dark:prose-invert dark:text-zinc-200'
                      dangerouslySetInnerHTML={{ __html: sanitizeDescriptionHtml(selectedVM.config.description) }}
                    />
                  </div>
                </>
              )}
            </div>
          )
        )}
      </Dialog>

      <Dialog open={!!selectedPortVM} onClose={() => setSelectedPortVM(null)} title={`Ports - ${selectedPortVM?.name ?? ''}`}>
        {selectedPortVM && (
          <div className='space-y-3 text-sm'>
            <div className='flex items-center justify-between'>
              <Badge variant='outline'>{selectedPortVM.ip}</Badge>
              <Button size='sm' onClick={() => window.open(`http://${selectedPortVM.ip}`, '_blank')}>
                <ExternalLink className='mr-1 h-3 w-3' /> Open
              </Button>
            </div>
            <div className='flex flex-wrap gap-2'>
              {selectedPortVM.ports.map((port) => (
                <Button key={port} size='sm' variant='outline' onClick={() => window.open(`http://${selectedPortVM.ip}:${port}`, '_blank')}>
                  {port}
                </Button>
              ))}
            </div>
          </div>
        )}
      </Dialog>
    </main>
  )
}
