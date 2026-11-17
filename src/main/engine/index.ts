// 引擎编排：config + procman + gateway + hosts + certs + autostart 的接线层（零 electron 依赖）
import * as fs from 'node:fs'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { EventEmitter } from 'node:events'
import {
  AppState, ConfigFile, IpcResult, LogLine, Project, ProjState, Settings, Warning, defaultConfig, makeDomain
} from '@shared/types'
import { ConfigStore } from './config'
import { LogHub } from './logs'
import { ProcMan } from './procman'
import { Gateway, Route } from './gateway'
import { HostsManager, HostsEntry, ElevateFn, defaultElevate } from './hosts'
import { CertManager } from './certs'
import { AutoStart } from './autostart'
import { detectProject, DetectResult } from './detect'

export interface EngineOptions {
  dataDir: string           // %APPDATA%\LocalDeploy 或临时目录（演练注入）
  exePath?: string          // 自启注册用
  mkcertPath?: string       // resources/mkcert/mkcert.exe
  hostsPath?: string        // 默认系统 hosts；测试注入临时文件
  elevate?: ElevateFn | null // null = 不弹 UAC（降级路径演练用）
  procShell?: boolean
}

export interface EngineEvents {
  state: (s: AppState) => void
  log: (projectId: string, lines: LogLine[]) => void
}

export class Engine extends EventEmitter {
  readonly opts: EngineOptions
  readonly store: ConfigStore
  readonly proc: ProcMan
  private gw: Gateway | null = null
  private hosts: HostsManager
  private certs: CertManager | null = null
  readonly autostart = new AutoStart()
  private logHubs = new Map<string, LogHub>()
  private lastExitNotified = new Map<string, string>()
  private hostsOk = true
  private hostsError?: string
  private warnings = new Map<string, Warning>() // key: code+projectId

  constructor(opts: EngineOptions) {
    super()
    this.opts = opts
    const cfgPath = path.join(opts.dataDir, 'config.yaml')
    this.store = new ConfigStore({ configPath: cfgPath, ...(opts.hostsPath ? { hostsPath: opts.hostsPath } : {}) })
    this.proc = new ProcMan(defaultConfig().settings.proc, { ...(opts.procShell !== undefined ? { shell: opts.procShell } : {}) })
    this.hosts = new HostsManager({
      hostsPath: opts.hostsPath ?? this.store.hostsPath,
      ...(opts.elevate === null ? {} : { elevate: opts.elevate ?? defaultElevate })
    })
    if (opts.mkcertPath) {
      this.certs = new CertManager({
        mkcertPath: opts.mkcertPath,
        caroot: path.join(opts.dataDir, 'caroot'),
        certDir: path.join(opts.dataDir, 'certs'),
        suffix: '.zjj'
      })
    }
  }

  // ---------- 生命周期 ----------
  async boot(): Promise<void> {
    try {
      this.store.load()
    } catch (e) {
      // 解析失败：用默认配置继续但报警告
      this.cfg().settings = defaultConfig().settings
      this.warn({ code: 'W_CONFIG_PARSE', message: `config.yaml 解析失败，使用默认：${(e as Error).message}` })
    }
    this.proc.updateSettings(this.cfg().settings.proc)
    for (const p of this.cfg().projects) this.proc.register(p, this.hubFor(p))
    this.store.onChange = (next, prev) => { void this.applyConfigChange(next, prev).catch(e => {
      this.warn({ code: 'W_CONFIG_APPLY', message: `配置热应用失败：${(e as Error).message}` })
    }) }
    this.store.onParseError = (e) => {
      this.warn({ code: 'W_CONFIG_PARSE', message: `config.yaml 解析失败，已保留旧配置：${e.message}` })
    }
    this.store.watch()
    this.proc.on('status', (id, status, detail) => {
      if (status === 'crashed' || status === 'stopped') { /* 状态本身即通知 */ }
      this.emitState()
    })
    // 网关
    await this.startGateway()
    // hosts 全量对账（幂等）
    await this.syncHosts(true)
    // 恢复 desired 项目
    const s = this.cfg().settings
    if (s.autostart.resumeProjects) {
      for (const p of this.cfg().projects) {
        if (p.autoStart && p.type === 'process') {
          try { await this.proc.start(p.id) } catch { /* 状态已置 */ }
        }
      }
    }
    this.emitState()
  }

  async shutdown(): Promise<void> {
    await this.proc.shutdownAll()
    for (const h of this.logHubs.values()) h.closeFile()
    await this.enqueueGw(async () => {
      if (this.gw) { await this.gw.stop(); this.gw = null }
    })
    await this.store.close()
  }

  private cfg(): ConfigFile { return this.store.current }

  // ---------- M3：网关操作单队列串行，防三路径并发 stop/start ----------
  private gwQueue: Promise<void> = Promise.resolve()
  private enqueueGw(fn: () => Promise<void>): Promise<void> {
    const run = this.gwQueue.then(fn, fn)
    this.gwQueue = run.then(() => undefined, () => undefined)
    return this.gwQueue.then(() => undefined, () => undefined)
  }

  private startGateway(): Promise<void> {
    return this.enqueueGw(async () => {
      const st = await this.buildGateway().start()
      this.gwState = st
      if (!st.running) this.warn({ code: 'W_GATEWAY_BIND', message: st.error ?? '网关启动失败' })
      else this.unwarn('W_GATEWAY_BIND')
      this.emitState()
    })
  }
  private gwState: AppState['gateway'] = { running: false, httpPort: 0, httpsPort: 0, httpsActive: false }

  private buildGateway(): Gateway {
    const s = this.cfg().settings
    this.gw = new Gateway({
      httpPort: s.gateway.httpPort,
      httpsPort: s.gateway.httpsPort,
      httpsEnabled: s.gateway.httpsEnabled,
      httpsRedirect: s.gateway.httpsRedirect,
      ...(this.gwCert() ? { cert: this.gwCert() } : {})
    })
    this.gw.setRoutes(this.routes())
    return this.gw
  }

  private gwCert(): { key: string; cert: string } | null {
    const s = this.cfg().settings
    if (!s.gateway.httpsEnabled || !this.certs) return null
    const c = this.certs.load()
    if (!c) {
      void this.certs.ensure().then(r => {
        if (!r.ok) this.warn({ code: 'W_CERT_UNAVAILABLE', message: r.error ?? '证书不可用' })
        else { this.unwarn('W_CERT_UNAVAILABLE'); void this.startGateway() }
      })
      return null
    }
    return c
  }

  private routes(): Route[] {
    return this.cfg().projects
      .filter(p => p.domain)
      .map(p => p.type === 'static'
        ? { domain: p.domain, type: 'static' as const, root: p.dir!, spa: p.spa ?? true }
        : { domain: p.domain, type: 'proxy' as const, port: p.port! })
  }

  private logDir(): string { return path.join(this.opts.dataDir, 'logs') }

  private hubFor(p: Project): LogHub {
    let h = this.logHubs.get(p.id)
    if (!h) {
      h = new LogHub(this.cfg().settings.logs)
      h.attachFile(this.logDir(), p.id)
      this.logHubs.set(p.id, h)
    }
    return h
  }

  // ---------- 配置变更热应用 ----------
  private async applyConfigChange(next: ConfigFile, prev: ConfigFile): Promise<void> {
    this.proc.updateSettings(next.settings.proc)
    for (const h of this.logHubs.values()) h.updateSettings(next.settings.logs)
    // 项目 diff
    const prevIds = new Map(prev.projects.map(p => [p.id, p]))
    for (const p of next.projects) {
      const old = prevIds.get(p.id)
      if (!old) { this.proc.register(p, this.hubFor(p)) }
      else {
        this.proc.updateProject(p)
        if (p.domain !== old.domain || p.dir !== old.dir || p.port !== old.port) {
          // hosts 与路由重建
        }
      }
    }
    for (const p of prev.projects) {
      if (!next.projects.find(q => q.id === p.id)) {
        try { await this.proc.stop(p.id) } catch { /* ignore */ }
        this.proc.unregister(p.id)
        this.logHubs.get(p.id)?.closeFile()
        this.logHubs.delete(p.id)
      }
    }
    // 网关端口/HTTPS/路由变更 → 重启
    const gChanged = JSON.stringify(next.settings.gateway) !== JSON.stringify(prev.settings.gateway) ||
      JSON.stringify(this.routesKey(next)) !== JSON.stringify(this.routesKey(prev))
    if (gChanged) await this.restartGateway()
    await this.syncHosts(true)
    this.emitState()
  }

  private routesKey(c: ConfigFile): string[] {
    return c.projects.filter(p => p.domain).map(p => `${p.domain}|${p.type}|${p.dir ?? ''}|${p.port ?? ''}|${p.spa ? 1 : 0}`).sort()
  }

  private restartGateway(): Promise<void> {
    return this.enqueueGw(async () => {
      const old = this.gw
      if (old) await old.stop() // 先停旧再启新：同端口重绑否则 EADDRINUSE
      const gw = this.buildGateway()
      await gw.start()
      this.gwState = gw.state
      if (!gw.state.running) this.warn({ code: 'W_GATEWAY_BIND', message: gw.state.error ?? '网关启动失败' })
      else this.unwarn('W_GATEWAY_BIND')
      this.emitState()
    })
  }

  // ---------- hosts ----------
  private async syncHosts(full: boolean): Promise<void> {
    const s = this.cfg().settings
    if (!s.domain.hostsManaged) { this.hostsOk = true; return }
    const entries: HostsEntry[] = full
      ? this.cfg().projects.filter(p => p.domain).map(p => ({ domain: p.domain, op: 'add' as const }))
      : []
    if (!full) return
    const r = await this.hosts.apply(entries, full)
    if (r.ok) { this.hostsOk = true; this.hostsError = undefined; this.unwarn('W_HOSTS_DENIED'); this.unwarn('W_HOSTS_CORRUPT') }
    else {
      this.hostsOk = false
      this.hostsError = r.message
      if (r.code === 'corrupt') this.warn({ code: 'W_HOSTS_CORRUPT', message: r.message ?? '' })
      else this.warn({ code: 'W_HOSTS_DENIED', message: r.message ?? 'hosts 写入被拒' })
    }
  }

  // ---------- 快照 ----------
  state(): AppState {
    const projects: ProjState[] = this.cfg().projects.map(p => {
      const st = this.proc.get(p.id)
      const urls: string[] = []
      const gs = this.gwState
      if (p.domain && gs.running) {
        const httpish = gs.httpsActive && p.domain ? `https://${p.domain}${gs.httpsPort !== 443 ? ':' + gs.httpsPort : ''}` : null
        if (httpish) urls.push(httpish)
        if (gs.httpPort !== 80) urls.push(`http://${p.domain}:${gs.httpPort}`)
        else urls.push(`http://${p.domain}`)
      }
      if (p.type === 'process' && p.port) urls.push(`http://localhost:${p.port}`)
      return {
        project: p,
        status: st?.status ?? 'idle',
        desired: st?.desired ?? false,
        ...(st?.pid !== undefined ? { pid: st.pid } : {}),
        restartsInFlight: st?.restartsInFlight ?? 0,
        ...(st?.lastExit ? { lastExit: st.lastExit } : {}),
        urls,
        warnings: [...this.warnings.values()].filter(w => w.projectId === p.id)
      }
    })
    return {
      projects,
      settings: structuredClone(this.cfg().settings),
      gateway: structuredClone(this.gwState),
      hosts: { ok: this.hostsOk, ...(this.hostsError ? { error: this.hostsError } : {}) },
      cert: { installed: false },
      warnings: [...this.warnings.values()].filter(w => !w.projectId)
    }
  }

  private warn(w: Warning): void {
    this.warnings.set(w.code + (w.projectId ?? ''), w)
    this.emitState()
  }
  private unwarn(code: string): void {
    for (const k of [...this.warnings.keys()]) if (k.startsWith(code)) this.warnings.delete(k)
  }

  private emitState(): void { this.emit('state', this.state()) }

  // ---------- IPC 面（纯异步方法，Electron 层只做转发）----------
  async apiGetState(): Promise<IpcResult<AppState>> { return { ok: true, data: this.state() } }

  async apiProjectDetect(dir: string): Promise<IpcResult<DetectResult | null>> {
    try { return { ok: true, data: detectProject(dir) } } catch (e) { return { ok: false, code: 'E_DETECT', message: String((e as Error).message) } }
  }

  private newId(): string {
    return 'p-' + randomBytes(4).toString('hex').slice(0, 6)
  }

  async apiProjectAdd(spec: Partial<Project> & { name: string; type: Project['type'] }): Promise<IpcResult<Project>> {
    const taken = new Set(this.cfg().projects.map(p => p.domain).filter(Boolean) as string[])
    const domain = spec.domain !== undefined ? spec.domain : makeDomain(spec.name, this.cfg().settings.domain.suffix, taken)
    const p: Project = {
      id: this.newId(), name: spec.name, domain, type: spec.type,
      autoStart: !!spec.autoStart, restartOnCrash: spec.restartOnCrash ?? null,
      ...(spec.dir !== undefined ? { dir: spec.dir } : {}),
      ...(spec.spa !== undefined ? { spa: spec.spa } : {}),
      ...(spec.command !== undefined ? { command: spec.command } : {}),
      ...(spec.args !== undefined ? { args: spec.args } : {}),
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.env !== undefined ? { env: spec.env } : {}),
      ...(spec.port !== undefined ? { port: spec.port } : {})
    }
    const next: ConfigFile = { ...structuredClone(this.cfg()), projects: [...structuredClone(this.cfg()).projects, p] }
    try {
      this.store.save(next)
    } catch (e) {
      return { ok: false, code: 'E_VALIDATION', message: (e as Error).message }
    }
    // save 已触发 onChange 热应用；若配置项无变化则补注册
    if (!this.proc.get(p.id)) this.proc.register(p, this.hubFor(p))
    const w = this.state().projects.find(x => x.project.id === p.id)?.warnings ?? []
    return { ok: true, data: p, warnings: w }
  }

  async apiProjectUpdate(id: string, patch: Partial<Project>): Promise<IpcResult<Project>> {
    const cur = this.cfg().projects.find(p => p.id === id)
    if (!cur) return { ok: false, code: 'E_NOT_FOUND', message: id }
    const merged: Project = { ...structuredClone(cur), ...structuredClone(patch), id }
    const next: ConfigFile = { ...structuredClone(this.cfg()), projects: this.cfg().projects.map(p => p.id === id ? merged : p) }
    try { this.store.save(next) } catch (e) { return { ok: false, code: 'E_VALIDATION', message: (e as Error).message } }
    return { ok: true, data: merged }
  }

  async apiProjectRemove(id: string): Promise<IpcResult<null>> {
    const cur = this.cfg().projects.find(p => p.id === id)
    if (!cur) return { ok: false, code: 'E_NOT_FOUND', message: id }
    const next: ConfigFile = { ...structuredClone(this.cfg()), projects: this.cfg().projects.filter(p => p.id !== id) }
    this.store.save(next)
    // 清理该项目 hosts 域（save 热应用里 syncHosts(full) 已按新集重建；这里兜底直接删）
    if (cur.domain) await this.hosts.apply([{ domain: cur.domain, op: 'remove' }]).catch(() => undefined)
    this.deleteLogFiles(id)
    return { ok: true, data: null }
  }

  private deleteLogFiles(id: string): void {
    const base = path.join(this.logDir(), `${id}.log`)
    try {
      fs.rmSync(base, { force: true })
      for (let i = 1; i <= 10; i++) fs.rmSync(`${base}.${i}`, { force: true })
    } catch { /* ignore */ }
  }

  async apiProjectStart(id: string): Promise<IpcResult<string>> {
    const p = this.cfg().projects.find(x => x.id === id)
    if (!p) return { ok: false, code: 'E_NOT_FOUND', message: id }
    if (p.type === 'process') {
      try { await this.proc.start(id) } catch (e) { return { ok: false, code: 'E_SPAWN', message: (e as Error).message } }
    }
    return { ok: true, data: this.proc.get(id)?.status ?? 'running' }
  }

  async apiProjectStop(id: string): Promise<IpcResult<string>> {
    try { await this.proc.stop(id) } catch { /* 未注册也视为停 */ }
    return { ok: true, data: this.proc.get(id)?.status ?? 'stopped' }
  }

  async apiProjectRestart(id: string): Promise<IpcResult<string>> {
    try { await this.proc.restart(id) } catch (e) { return { ok: false, code: 'E_RESTART', message: (e as Error).message } }
    return { ok: true, data: this.proc.get(id)?.status ?? 'running' }
  }

  apiLogsGet(id: string, sinceSeq = 0, limit = 500): IpcResult<{ lines: LogLine[]; eof: boolean }> {
    const h = this.logHubs.get(id)
    if (!h) return { ok: true, data: { lines: [], eof: true } }
    return { ok: true, data: h.get(sinceSeq, limit) }
  }

  apiLogsClear(id: string): IpcResult<null> {
    this.logHubs.get(id)?.clear()
    return { ok: true, data: null }
  }

  async apiSettingsUpdate(patch: Partial<Settings>): Promise<IpcResult<Settings>> {
    const cur = this.cfg()
    // M5：与当前 settings 深合并（按节 spread），缺节保留现值而非回落默认
    const merged: Settings = structuredClone(cur.settings)
    for (const k of ['gateway', 'domain', 'proc', 'logs', 'autostart'] as const) {
      if (patch[k]) Object.assign(merged[k], patch[k])
    }
    const prevBoot = cur.settings.autostart.appOnBoot
    const next: ConfigFile = { ...structuredClone(cur), settings: merged }
    try { this.store.save(next) } catch (e) { return { ok: false, code: 'E_VALIDATION', message: (e as Error).message } }
    // M6：appOnBoot 变化联动注册表（注册表为准；失败时把 config 镜像回滚并警告）
    if (merged.autostart.appOnBoot !== prevBoot) {
      const exe = this.opts.exePath ?? process.execPath
      const r = await this.autostart.setEnabled(exe, merged.autostart.appOnBoot)
      if (!r.ok) {
        this.warn({ code: 'W_AUTOSTART_DENIED', message: r.error ?? '注册表写入失败' })
        const rollback: ConfigFile = { ...structuredClone(this.cfg()) }
        rollback.settings.autostart.appOnBoot = prevBoot
        try { this.store.save(rollback) } catch { /* keep warning */ }
        return { ok: false, code: 'E_AUTOSTART', message: r.error ?? '' }
      }
      this.unwarn('W_AUTOSTART_DENIED')
    }
    // HTTPS 开关变化时确保证书就位（文件写好后 gwCert 回调会再启一次；均走串行队列）
    if (merged.gateway.httpsEnabled && this.certs) {
      const r = await this.certs.ensure()
      if (!r.ok) this.warn({ code: 'W_CERT_UNAVAILABLE', message: r.error ?? 'HTTPS 证书不可用' })
      else this.unwarn('W_CERT_UNAVAILABLE')
    }
    return { ok: true, data: this.cfg().settings }
  }

  async apiHostsRetry(): Promise<IpcResult<null>> {
    await this.syncHosts(true)
    return { ok: true, data: null, warnings: [...this.warnings.values()] }
  }

  async apiCertStatus(): Promise<IpcResult<{ installed: boolean; notAfterIso?: string }>> {
    if (!this.certs) return { ok: true, data: { installed: false } }
    return { ok: true, data: await this.certs.status() }
  }

  async apiCertRenew(): Promise<IpcResult<{ ok: boolean; error?: string }>> {
    if (!this.certs) return { ok: false, code: 'E_NO_MKCERT', message: 'mkcert 未捆绑' }
    return { ok: true, data: await this.certs.renew() }
  }

  async apiAutostartSet(enabled: boolean): Promise<IpcResult<boolean>> {
    const exe = this.opts.exePath ?? process.execPath
    const r = await this.autostart.setEnabled(exe, enabled)
    if (!r.ok) { this.warn({ code: 'W_AUTOSTART_DENIED', message: r.error ?? '注册表写入失败' }); return { ok: false, code: 'E_AUTOSTART', message: r.error ?? '' } }
    this.unwarn('W_AUTOSTART_DENIED')
    // M6：成功后把真实状态镜像进 config，保持单一显示事实源
    if (this.cfg().settings.autostart.appOnBoot !== enabled) {
      const next: ConfigFile = structuredClone(this.cfg())
      next.settings.autostart.appOnBoot = enabled
      try { this.store.save(next) } catch { /* 镜像失败不影响注册表真值 */ }
    }
    return { ok: true, data: enabled }
  }
}
