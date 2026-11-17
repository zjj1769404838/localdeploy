// 配置加载/校验/原子保存/热加载（docs/03 §1 契约实现）
import * as fs from 'node:fs'
import * as path from 'node:path'
import yaml from 'js-yaml'
import {
  CONFIG_VERSION, ConfigFile, Settings, Project, DEFAULT_SETTINGS, defaultConfig
} from '@shared/types'

export interface ConfigIssue {
  path: string
  message: string
}

export class ConfigError extends Error {
  issues: ConfigIssue[]
  constructor(issues: ConfigIssue[]) {
    super(issues.map(i => `${i.path}: ${i.message}`).join('; '))
    this.name = 'ConfigError'
    this.issues = issues
  }
}

export function validateConfig(raw: unknown): ConfigFile {
  const issues: ConfigIssue[] = []
  if (typeof raw !== 'object' || raw === null) {
    throw new ConfigError([{ path: '', message: '根节点必须是对象' }])
  }
  const r = raw as Record<string, unknown>
  if (r.version !== CONFIG_VERSION) {
    issues.push({ path: 'version', message: `仅支持 version=${CONFIG_VERSION}，实际 ${String(r.version)}` })
  }
  const settings = mergeSettings(r.settings)
  const projects = parseProjects(r.projects)
  // 域名唯一性
  const seen = new Set<string>()
  for (const p of projects) {
    if (p.domain) {
      if (seen.has(p.domain)) issues.push({ path: `projects[${p.id}].domain`, message: `域名重复: ${p.domain}` })
      seen.add(p.domain)
    }
  }
  if (issues.length) throw new ConfigError(issues)
  return { version: CONFIG_VERSION, settings, projects }
}

function mergeSettings(raw: unknown): Settings {
  const s = structuredClone(DEFAULT_SETTINGS)
  if (typeof raw !== 'object' || raw === null) return s
  const g = (raw as Record<string, unknown>)
  const pick = <K extends keyof Settings>(sec: K, vals: unknown) => {
    if (typeof vals !== 'object' || vals === null) return
    for (const [k, v] of Object.entries(vals as Record<string, unknown>)) {
      if (!(k in s[sec])) continue
      const cur = s[sec][k as keyof Settings[K]]
      if (typeof cur === typeof v) (s[sec] as unknown as Record<string, unknown>)[k] = v
    }
  }
  pick('gateway', g.gateway); pick('domain', g.domain); pick('proc', g.proc)
  pick('logs', g.logs); pick('autostart', g.autostart)
  // 范围校验
  const inRange = (v: number, lo: number, hi: number) => v >= lo && v <= hi
  const gv = s.gateway
  if (!inRange(gv.httpPort, 1, 65535)) issues0('gateway.httpPort')
  if (!inRange(gv.httpsPort, 1, 65535)) issues0('gateway.httpsPort')
  const pv = s.proc
  if (!inRange(pv.backoffBaseMs, 100, 60000)) issues0('proc.backoffBaseMs')
  if (!inRange(pv.backoffCapMs, 1000, 600000)) issues0('proc.backoffCapMs')
  if (!inRange(pv.maxRestarts, 0, 100)) issues0('proc.maxRestarts')
  if (!inRange(pv.killTimeoutMs, 1000, 60000)) issues0('proc.killTimeoutMs')
  const lv = s.logs
  if (!inRange(lv.ringLines, 100, 100000)) issues0('logs.ringLines')
  if (!inRange(lv.fileSizeMb, 1, 100)) issues0('logs.fileSizeMb')
  if (!inRange(lv.fileKeep, 1, 10)) issues0('logs.fileKeep')
  if (!/^\.[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(s.domain.suffix)) issues0('domain.suffix')
  function issues0(p: string) { throw new ConfigError([{ path: p, message: '取值越界或格式非法' }]) }
  return s
}

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

function parseProjects(raw: unknown): Project[] {
  if (raw === undefined || raw === null) return []
  if (!Array.isArray(raw)) throw new ConfigError([{ path: 'projects', message: '必须是数组' }])
  const out: Project[] = []
  const ids = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i] as Record<string, unknown>
    const at = `projects[${i}]`
    if (typeof e !== 'object' || e === null) throw new ConfigError([{ path: at, message: '必须是对象' }])
    const id = String(e.id ?? '')
    if (!/^p-[a-z0-9]{4,10}$/.test(id)) throw new ConfigError([{ path: `${at}.id`, message: 'id 非法' }])
    if (ids.has(id)) throw new ConfigError([{ path: `${at}.id`, message: `id 重复 ${id}` }])
    ids.add(id)
    const name = String(e.name ?? '')
    if (!name || name.length > 64) throw new ConfigError([{ path: `${at}.name`, message: 'name 需 1-64 字符' }])
    const type = e.type === 'static' || e.type === 'process' ? e.type : null
    if (!type) throw new ConfigError([{ path: `${at}.type`, message: 'type 必须 static|process' }])
    const domain = e.domain === undefined || e.domain === null ? '' : String(e.domain)
    if (domain && !DOMAIN_RE.test(domain)) throw new ConfigError([{ path: `${at}.domain`, message: `domain 格式非法: ${domain}` }])
    const p: Project = {
      id, name, domain, type,
      autoStart: !!e.autoStart,
      restartOnCrash: e.restartOnCrash === null || e.restartOnCrash === undefined ? null : !!e.restartOnCrash
    }
    if (type === 'static') {
      if (typeof e.dir !== 'string' || !e.dir) throw new ConfigError([{ path: `${at}.dir`, message: 'static 项目必须有 dir' }])
      p.dir = e.dir
      p.spa = e.spa === undefined ? true : !!e.spa
    } else {
      if (typeof e.command !== 'string' || !e.command) throw new ConfigError([{ path: `${at}.command`, message: 'process 项目必须有 command' }])
      p.command = e.command
      p.args = Array.isArray(e.args) ? e.args.map(String) : []
      p.cwd = typeof e.cwd === 'string' ? e.cwd : undefined
      p.env = typeof e.env === 'object' && e.env !== null ? Object.fromEntries(Object.entries(e.env as object).map(([k, v]) => [k, String(v)])) : {}
      const port = Number(e.port)
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError([{ path: `${at}.port`, message: 'process 项目 port 必须 1..65535' }])
      p.port = port
    }
    out.push(p)
  }
  return out
}

export interface ConfigStoreOptions {
  configPath: string
  hostsPath?: string // 供测试注入；默认 C:\Windows\System32\drivers\etc\hosts
}

export class ConfigStore {
  readonly configPath: string
  readonly hostsPath: string
  private cfg: ConfigFile
  private lastHash = ''
  private saveTimer: NodeJS.Timeout | null = null
  private watcher: fs.FSWatcher | null = null
  onChange: ((next: ConfigFile, prev: ConfigFile) => void) | null = null
  onParseError: ((err: Error) => void) | null = null

  constructor(opts: ConfigStoreOptions) {
    this.configPath = opts.configPath
    this.hostsPath = opts.hostsPath ?? path.win32.join('C:', 'Windows', 'System32', 'drivers', 'etc', 'hosts')
    this.cfg = defaultConfig()
  }

  get current(): ConfigFile { return this.cfg }

  /** 首次加载：不存在则生成默认；解析失败抛错（调用方决定用默认值继续） */
  load(): ConfigFile {
    if (!fs.existsSync(this.configPath)) {
      const def = defaultConfig()
      this.writeAtomic(this.configPath, yaml.dump(def))
      this.cfg = def
    } else {
      this.cfg = this.parseFile(this.configPath)
    }
    this.lastHash = this.hashFile(this.configPath)
    return this.cfg
  }

  private parseFile(fp: string): ConfigFile {
    const text = fs.readFileSync(fp, 'utf8')
    const raw = yaml.load(text)
    return validateConfig(raw)
  }

  private hashFile(fp: string): string {
    try {
      const st = fs.statSync(fp)
      return `${st.size}:${st.mtimeMs}`
    } catch { return '' }
  }

  private writeAtomic(fp: string, text: string): void {
    fs.mkdirSync(path.dirname(fp), { recursive: true })
    const tmp = fp + '.tmp'
    fs.writeFileSync(tmp, text, 'utf8')
    if (fs.existsSync(fp)) fs.rmSync(fp)
    fs.renameSync(tmp, fp)
  }

  /** UI 侧保存：校验 → 原子写 → 刷新内存与 hash（防自激） */
  save(next: ConfigFile): void {
    const validated = validateConfig(next)
    this.writeAtomic(this.configPath, yaml.dump(validated))
    const prev = this.cfg
    this.cfg = validated
    this.lastHash = this.hashFile(this.configPath)
    this.onChange?.(validated, prev)
  }

  /** 外部编辑热加载。chokidar 不可用时退化为 fs.watch */
  watch(): void {
    const dir = path.dirname(this.configPath)
    const file = path.basename(this.configPath)
    try {
      // 延迟 require 以便无 chokidar 环境可测
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const chokidar = require('chokidar')
      const w = chokidar.watch(this.configPath, { ignoreInitial: true, awaitWriteFinish: { stabilityThreshold: 300, pollInterval: 100 } })
      w.on('change', () => this.reloadIfChanged())
      w.on('add', () => this.reloadIfChanged())
      this.watcher = w
    } catch {
      this.watcher = fs.watch(dir, (_ev, fn) => {
        if (fn === file) setTimeout(() => this.reloadIfChanged(), 350)
      })
    }
  }

  reloadIfChanged(): boolean {
    const h = this.hashFile(this.configPath)
    if (h === this.lastHash) return false
    this.lastHash = h
    try {
      const next = this.parseFile(this.configPath)
      const prev = this.cfg
      this.cfg = next
      this.onChange?.(next, prev)
      return true
    } catch (e) {
      this.onParseError?.(e as Error)
      return false
    }
  }

  async close(): Promise<void> {
    if (this.watcher && 'close' in this.watcher) await (this.watcher as { close(): void | Promise<void> }).close()
    if (this.saveTimer) clearTimeout(this.saveTimer)
  }
}
