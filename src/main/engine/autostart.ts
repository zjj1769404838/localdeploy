// 开机自启：HKCU Run 键（无管理员，Q11/D11）
import { execFile } from 'node:child_process'

export interface AutoStartDeps {
  run?: (exe: string, args: string[]) => Promise<number>
}

const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
const VALUE = 'LocalDeploy'

const defaultRun = (exe: string, args: string[]) =>
  new Promise<number>((resolve) => {
    execFile(exe, args, { windowsHide: true }, (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0))
  })

export class AutoStart {
  private run: NonNullable<AutoStartDeps['run']>
  constructor(deps: AutoStartDeps = {}) { this.run = deps.run ?? defaultRun }

  async setEnabled(exePath: string, enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    try {
      if (enabled) {
        const code = await this.run('reg.exe', ['add', KEY, '/v', VALUE, '/t', 'REG_SZ', '/d', `"${exePath}"`, '/f'])
        if (code !== 0) return { ok: false, error: `reg add exit ${code}` }
      } else {
        const code = await this.run('reg.exe', ['delete', KEY, '/v', VALUE, '/f'])
        // 值不存在时 reg 返回 103/错误码，视为已关
        if (code !== 0 && code !== 1060) return { ok: false, error: `reg delete exit ${code}` }
      }
      return { ok: true }
    } catch (e) {
      return { ok: false, error: String((e as Error).message) }
    }
  }

  async isEnabled(): Promise<boolean> {
    const code = await this.run('reg.exe', ['query', KEY, '/v', VALUE])
    return code === 0
  }
}
