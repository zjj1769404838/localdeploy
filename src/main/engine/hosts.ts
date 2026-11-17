// hosts 托管区块读写 + 提权自举 + 降级警告（docs/02 §3.4, docs/03 §1.2）
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawn } from 'node:child_process'

export const BEGIN = '# BEGIN LOCALDEPLOY MANAGED (do not edit between markers)'
export const END = '# END LOCALDEPLOY MANAGED'

export type HostsOp = 'add' | 'remove'
export interface HostsEntry { domain: string; op: HostsOp }

/** 对文本应用区块变更（纯函数，可单测）；返回新文本或错误码 */
export function applyBlock(text: string, entries: HostsEntry[]): { ok: true; text: string } | { ok: false; code: 'corrupt' } {
  const bCount = text.split('\n').filter(l => l.trim() === BEGIN).length
  const eCount = text.split('\n').filter(l => l.trim() === END).length
  if (bCount > 1 || eCount > 1) return { ok: false, code: 'corrupt' }
  if (bCount === 1 && eCount === 0) return { ok: false, code: 'corrupt' }

  let before = text
  let block: string[] = []
  if (bCount === 1) {
    const lines = text.split('\n')
    const bi = lines.findIndex(l => l.trim() === BEGIN)
    const ei = lines.findIndex(l => l.trim() === END)
    if (ei < bi) return { ok: false, code: 'corrupt' }
    before = lines.slice(0, bi).join('\n')
    const after = lines.slice(ei + 1).join('\n')
    block = lines.slice(bi + 1, ei)
    before = before === '' ? after : (after === '' ? before : before + '\n' + after)
  }
  // 当前域集合
  const domains = new Set<string>()
  for (const l of block) {
    const m = l.trim().match(/^(?:127\.0\.0\.1|::1)\s+(\S+)$/)
    if (m && m[1]) domains.add(m[1])
  }
  for (const e of entries) {
    if (e.op === 'add') domains.add(e.domain)
    else domains.delete(e.domain)
  }
  const sorted = [...domains].sort()
  const newBlock = sorted.length === 0
    ? ''
    : [BEGIN, ...sorted.flatMap(d => [`127.0.0.1 ${d}`, `::1 ${d}`]), END].join('\n')
  let out = before.replace(/\s+$/, '')
  if (newBlock) out = (out ? out + '\n' : '') + newBlock + '\n'
  else if (out) out += '\n'
  return { ok: true, text: out }
}

export interface HostsResult {
  ok: boolean
  degraded: boolean // true = 已降级（未生效但流程继续）
  code?: 'corrupt' | 'denied' | 'elevate-canceled' | 'elevate-failed'
  message?: string
}

export interface HostsIO {
  read(fp: string): string
  write(fp: string, text: string): void
  exists(fp: string): boolean
}

export const defaultIO: HostsIO = {
  read: fp => fs.readFileSync(fp, 'utf8'),
  write: (fp, text) => fs.writeFileSync(fp, text, 'utf8'),
  exists: fp => fs.existsSync(fp)
}

/** 提权执行器：默认走 PowerShell Start-Process -Verb RunAs；测试注入桩 */
export type ElevateFn = (exe: string, args: string[]) => Promise<boolean /* 成功完成 */>

export interface HostsDeps {
  hostsPath: string
  io?: HostsIO
  elevate?: ElevateFn
  /** 提权模式下直接应用（供 --elevated-hosts 子命令） */
}

export class HostsManager {
  private deps: Required<Pick<HostsDeps, 'hostsPath' | 'io'>> & { elevate?: ElevateFn }
  constructor(deps: HostsDeps) {
    this.deps = { hostsPath: deps.hostsPath, io: deps.io ?? defaultIO, elevate: deps.elevate }
  }

  currentText(): string {
    try { return this.deps.io.read(this.deps.hostsPath) } catch { return '' }
  }

  /**
   * 应用变更。普通权限直写；EACCES/EPERM → 提权重试一次；仍失败 → 降级。
   * entries 为本次要做的操作（增量语义）。
   */
  async apply(entries: HostsEntry[]): Promise<HostsResult> {
    const text = this.currentText()
    const merged = applyBlock(text, entries)
    if (!merged.ok) {
      return { ok: false, degraded: false, code: 'corrupt', message: 'hosts 标记区块损坏，拒绝写入' }
    }
    // 无变化则跳过
    if (merged.text === text) return { ok: true, degraded: false }
    try {
      this.deps.io.write(this.deps.hostsPath, merged.text)
      return { ok: true, degraded: false }
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code !== 'EACCES' && code !== 'EPERM' && code !== 'EBUSY') {
        return { ok: false, degraded: true, code: 'denied', message: String((e as Error).message) }
      }
    }
    // 提权路径
    if (!this.deps.elevate) {
      return { ok: false, degraded: true, code: 'denied', message: '需要管理员权限写入 hosts（已跳过提权：未配置提权器）' }
    }
    const tmp = path.join(os.tmpdir(), `localdeploy-hosts-${Date.now()}.txt`)
    try {
      fs.writeFileSync(tmp, merged.text, 'utf8')
      const done = await this.deps.elevate(process.execPath, ['--elevated-hosts', tmp])
      if (!done) return { ok: false, degraded: true, code: 'elevate-canceled', message: 'UAC 提权未完成，域名暂不可用（端口直连不受影响）' }
      // 读回核验
      if (this.currentText() === merged.text) return { ok: true, degraded: false }
      return { ok: false, degraded: true, code: 'elevate-failed', message: '提权写入后核验失败' }
    } finally {
      fs.rmSync(tmp, { force: true })
    }
  }

  verifyContains(domain: string): boolean {
    return new RegExp(`^127\\.0\\.0\\.1\\s+${domain.replace(/\./g, '\\.')}$`, 'm').test(this.currentText())
  }
}

/** 提权 helper：本 exe 以 --elevated-hosts <tmpfile> 启动时调用，把临时文件整写 hosts */
export function runElevatedHelper(hostsPath: string, tmpFile: string): number {
  try {
    const text = fs.readFileSync(tmpFile, 'utf8')
    fs.writeFileSync(hostsPath, text, 'utf8')
    fs.rmSync(tmpFile, { force: true })
    return 0
  } catch {
    return 1
  }
}

export const defaultElevate: ElevateFn = (exe, args) =>
  new Promise((resolve) => {
    const ps = args.map(a => `'${a.replace(/'/g, "''")}'`).join(',')
    const cmd = `Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${ps} -Verb RunAs -WindowStyle Hidden -Wait`
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { windowsHide: true, stdio: 'ignore' })
    p.on('error', () => resolve(false))
    p.on('exit', code => resolve(code === 0))
  })
