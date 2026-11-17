// LocalDeploy 共享类型 — 与 docs/03-配置与接口契约.md 锁步
export const CONFIG_VERSION = 1

export type ProjectType = 'static' | 'process'
export type ProjStatus = 'idle' | 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed'

export interface GatewaySettings {
  httpPort: number
  httpsPort: number
  httpsEnabled: boolean
  httpsRedirect: boolean
}
export interface DomainSettings {
  suffix: string
  hostsManaged: boolean
}
export interface ProcSettings {
  restartOnCrash: boolean
  backoffBaseMs: number
  backoffCapMs: number
  maxRestarts: number
  killTimeoutMs: number
}
export interface LogSettings {
  ringLines: number
  fileSizeMb: number
  fileKeep: number
}
export interface AutostartSettings {
  appOnBoot: boolean
  resumeProjects: boolean
}
export interface Settings {
  gateway: GatewaySettings
  domain: DomainSettings
  proc: ProcSettings
  logs: LogSettings
  autostart: AutostartSettings
}

export interface Project {
  id: string
  name: string
  domain: string // '' = 不域名
  type: ProjectType
  dir?: string // static: 静态根
  spa?: boolean // static: SPA 回退，默认 true
  command?: string // process
  args?: string[] // process
  cwd?: string // process
  env?: Record<string, string> // process
  port?: number // process: 上游端口
  autoStart: boolean
  restartOnCrash: boolean | null // null=跟随全局
}

export interface ConfigFile {
  version: number
  settings: Settings
  projects: Project[]
}

export interface Warning {
  code: string // W_HOSTS_DENIED 等，见 docs/03 §3
  message: string
  projectId?: string
}

export interface ProjState {
  project: Project
  status: ProjStatus
  desired: boolean
  pid?: number
  restartsInFlight: number
  lastExit?: { code: number | null; signal: string | null; at: string }
  urls: string[] // 可打开的访问入口（含域名/端口直链）
  warnings: Warning[]
}

export interface AppState {
  projects: ProjState[]
  settings: Settings
  gateway: { running: boolean; error?: string; httpPort: number; httpsPort: number; httpsActive: boolean }
  hosts: { ok: boolean; error?: string }
  cert: { installed: boolean; notAfterIso?: string; error?: string }
  warnings: Warning[]
}

export interface LogLine {
  seq: number
  t: string
  line: string
  stream: 'out' | 'err'
}

export interface DetectResult {
  type: ProjectType
  dir?: string
  spa?: boolean
  command?: string
  args?: string[]
  cwd?: string
  port?: number
  hint?: string
}

export interface IpcResult<T = unknown> {
  ok: boolean
  data?: T
  code?: string
  message?: string
  warnings?: Warning[]
}

// ---- 默认值（唯一定义点）----
export const DEFAULT_SETTINGS: Settings = {
  gateway: { httpPort: 80, httpsPort: 443, httpsEnabled: false, httpsRedirect: true },
  domain: { suffix: '.zjj', hostsManaged: true },
  proc: { restartOnCrash: true, backoffBaseMs: 1000, backoffCapMs: 30000, maxRestarts: 5, killTimeoutMs: 10000 },
  logs: { ringLines: 2000, fileSizeMb: 5, fileKeep: 3 },
  autostart: { appOnBoot: false, resumeProjects: false }
}

export function defaultConfig(): ConfigFile {
  return { version: CONFIG_VERSION, settings: structuredClone(DEFAULT_SETTINGS), projects: [] }
}

// slug：项目名 → 域名标签（输出仅 ASCII，匹配 DOMAIN_RE）
export function slugName(name: string): string {
  const s = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return s || 'app'
}

export function makeDomain(name: string, suffix: string, taken: Set<string>): string {
  let base = slugName(name) + suffix
  if (!taken.has(base)) return base
  let i = 2
  while (taken.has(slugName(name) + '-' + i + suffix)) i++
  return slugName(name) + '-' + i + suffix
}
