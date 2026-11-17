// 进程守护：状态机 / spawn / 树杀 / 指数退避（docs/02 §3.2, docs/03 §3）
import { ChildProcess, spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { Project, ProcSettings, ProjStatus } from '@shared/types'
import { LogHub } from './logs'

export interface ProcEvents {
  status: (id: string, status: ProjStatus, detail?: { restartsInFlight: number; lastExit?: ExitInfo }) => void
}

export interface ExitInfo { code: number | null; signal: string | null; at: string }

interface Entry {
  project: Project
  status: ProjStatus
  desired: boolean
  child: ChildProcess | null
  restartsInFlight: number
  timer: NodeJS.Timeout | null
  lastExit?: ExitInfo
  logs: LogHub
}

export class ProcMan extends EventEmitter {
  private entries = new Map<string, Entry>()
  private settings: ProcSettings
  private opts: { shell?: boolean; killImpl?: (pid: number) => Promise<boolean> }

  constructor(settings: ProcSettings, opts: { shell?: boolean; killImpl?: (pid: number) => Promise<boolean> } = {}) {
    super()
    this.settings = settings
    this.opts = opts
  }

  updateSettings(s: ProcSettings): void { this.settings = s }

  register(project: Project, logs: LogHub): void {
    if (this.entries.has(project.id)) throw new Error(`already registered: ${project.id}`)
    this.entries.set(project.id, { project, status: 'idle', desired: false, child: null, restartsInFlight: 0, timer: null, logs })
  }

  unregister(id: string): void {
    const e = this.entries.get(id)
    if (!e) return
    if (e.timer) clearTimeout(e.timer)
    e.desired = false
    e.child = null
    e.status = 'idle'
    this.entries.delete(id)
  }

  get(id: string): { status: ProjStatus; desired: boolean; pid?: number; restartsInFlight: number; lastExit?: ExitInfo } | undefined {
    const e = this.entries.get(id)
    if (!e) return undefined
    return { status: e.status, desired: e.desired, pid: e.child?.pid ?? undefined, restartsInFlight: e.restartsInFlight, lastExit: e.lastExit }
  }

  private setStatus(e: Entry, s: ProjStatus): void {
    e.status = s
    this.emit('status', e.project.id, s, { restartsInFlight: e.restartsInFlight, lastExit: e.lastExit })
  }

  /** 用户/恢复拉起：置 desired=true */
  async start(id: string): Promise<void> {
    const e = this.entries.get(id)
    if (!e) throw new Error(`unknown project ${id}`)
    if (e.status === 'running' || e.status === 'starting') return // 幂等
    if (e.timer) { clearTimeout(e.timer); e.timer = null }
    e.desired = true
    e.restartsInFlight = 0
    await this.spawnOnce(e)
  }

  /** 用户停止：置 desired=false，杀树，不再重启 */
  async stop(id: string): Promise<void> {
    const e = this.entries.get(id)
    if (!e) throw new Error(`unknown project ${id}`)
    if (e.timer) { clearTimeout(e.timer); e.timer = null }
    e.desired = false
    if (e.status === 'idle' || e.status === 'stopped') { this.setStatus(e, 'stopped'); return }
    this.setStatus(e, 'stopping')
    await this.killTree(e)
    this.setStatus(e, 'stopped')
  }

  async restart(id: string): Promise<void> {
    await this.stop(id)
    await this.start(id)
  }

  /** 应用退出：停掉所有 desired 进程（不做重启） */
  async shutdownAll(): Promise<void> {
    for (const e of this.entries.values()) {
      if (e.timer) clearTimeout(e.timer)
      e.timer = null
      e.desired = false
      if (e.child) {
        const k = e.child
        e.child = null
        await this.killPid(k.pid ?? -1)
      }
    }
  }

  /** 项目配置更新（编辑后同步） */
  updateProject(p: Project): void {
    const e = this.entries.get(p.id)
    if (e) e.project = p
  }

  private backoffMs(attempt: number): number {
    const { backoffBaseMs, backoffCapMs } = this.settings
    return Math.min(backoffBaseMs * Math.pow(2, attempt - 1), backoffCapMs)
  }

  private spawnOnce(e: Entry): Promise<void> {
    return new Promise((resolve, reject) => {
      const p = e.project
      if (p.type !== 'process') { reject(new Error('static 项目由 staticsrv 伺服，不经 procman')); return }
      this.setStatus(e, 'starting')
      let child: ChildProcess
      try {
        child = spawn(p.command!, p.args ?? [], {
          cwd: p.cwd,
          env: { ...process.env, ...(p.env ?? {}) },
          shell: this.opts.shell ?? true, // npm 等需 shell；测试注入 false
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe']
        })
      } catch (err) {
        this.onExit(e, { code: -1, signal: null, at: new Date().toISOString() })
        reject(err as Error)
        return
      }
      e.child = child
      let settled = false
      child.on('error', (err) => {
        e.logs.push(`spawn error: ${err.message}`, 'err')
        if (!settled) { settled = true; reject(err) }
        // exit 事件可能不再触发，手动走退避
        if (e.status === 'starting' || e.status === 'running') {
          this.onExit(e, { code: null, signal: 'spawn-error', at: new Date().toISOString() })
        }
      })
      child.stdout?.on('data', (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) e.logs.push(l, 'out') })
      child.stderr?.on('data', (b: Buffer) => { for (const l of b.toString().split(/\r?\n/)) if (l.trim()) e.logs.push(l, 'err') })
      child.on('spawn', () => {
        if (!settled) { settled = true; this.setStatus(e, 'running'); resolve() }
      })
      child.on('exit', (code, signal) => {
        if (!settled) { settled = true; reject(new Error(`exited immediately code=${code} signal=${signal}`)) }
        this.onExit(e, { code, signal, at: new Date().toISOString() })
      })
    })
  }

  private onExit(e: Entry, info: ExitInfo): void {
    e.child = null
    e.lastExit = info
    if (!e.desired) { this.setStatus(e, 'stopped'); return }
    const restartEnabled = e.project.restartOnCrash ?? this.settings.restartOnCrash
    e.restartsInFlight += 1
    if (!restartEnabled || e.restartsInFlight > this.settings.maxRestarts) {
      this.setStatus(e, 'crashed')
      return
    }
    this.setStatus(e, 'starting') // 退避等待期显示 starting
    const wait = this.backoffMs(e.restartsInFlight)
    e.logs.push(`[localdeploy] process exited (${JSON.stringify(info)}), restart #${e.restartsInFlight} in ${wait}ms`, 'err')
    e.timer = setTimeout(() => {
      e.timer = null
      if (!e.desired) return
      this.spawnOnce(e).catch(() => { /* onExit 已处理 */ })
    }, wait)
  }

  private async killTree(e: Entry): Promise<void> {
    const pid = e.child?.pid
    e.child = null
    if (!pid) return
    await this.killPid(pid)
  }

  private async killPid(pid: number): Promise<void> {
    if (pid <= 0) return
    if (this.opts.killImpl) { await this.opts.killImpl(pid); return }
    await new Promise<void>((res) => {
      // Windows 树杀；兜底 timeout 防 taskkill 挂死
      const k = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      const to = setTimeout(() => { try { process.kill(pid) } catch { /* gone */ } res() }, this.settings.killTimeoutMs)
      k.on('exit', () => { clearTimeout(to); res() })
      k.on('error', () => { clearTimeout(to); try { process.kill(pid) } catch { /* gone */ } res() })
    })
  }
}
