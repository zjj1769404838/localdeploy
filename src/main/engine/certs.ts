// mkcert 捆绑调用：根 CA 安装 + *.zjj 通配符证书（docs/02 §3.5）
import * as fs from 'node:fs'
import * as path from 'node:path'
import { spawn } from 'node:child_process'
import { execFile } from 'node:child_process'

export interface CertDeps {
  mkcertPath: string   // resources/mkcert/mkcert.exe
  caroot: string       // %APPDATA%\LocalDeploy\caroot（隔离）
  certDir: string      // %APPDATA%\LocalDeploy\certs
  suffix: string       // .zjj
  run?: (exe: string, args: string[], env: NodeJS.ProcessEnv) => Promise<{ code: number; stdout: string; stderr: string }>
}

const defaultRun = (exe: string, args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(exe, args, { env, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout, stderr })
    })
  })

export interface CertStatus { installed: boolean; notAfterIso?: string; error?: string }

export class CertManager {
  private d: Required<Omit<CertDeps, 'suffix'>> & { suffix: string }
  constructor(deps: CertDeps) {
    this.d = { ...deps, run: deps.run ?? defaultRun }
  }

  private env(): NodeJS.ProcessEnv {
    return { ...process.env, CAROOT: this.d.caroot }
  }

  get certFile(): string { return path.join(this.d.certDir, `wildcard${this.d.suffix}.pem`) }
  get keyFile(): string { return path.join(this.d.certDir, `wildcard${this.d.suffix}-key.pem`) }

  async status(): Promise<CertStatus> {
    if (!fs.existsSync(this.d.mkcertPath)) return { installed: false, error: 'mkcert.exe 缺失' }
    const { code, stdout } = await this.d.run(this.d.mkcertPath, ['-caroot'], this.env())
    const caInstalled = code === 0 && fs.existsSync(path.join(this.d.caroot, 'rootCA.pem'))
    if (!caInstalled) return { installed: false }
    if (!fs.existsSync(this.certFile)) return { installed: true }
    return { installed: true, notAfterIso: this.readNotAfter() }
  }

  private readNotAfter(): string | undefined {
    try {
      const x = new (require('node:crypto').X509Certificate)(fs.readFileSync(this.certFile, 'utf8'))
      return new Date(x.validTo).toISOString()
    } catch { return undefined }
  }

  /** 安装根 CA（内部弹 UAC 由 mkcert 自己处理）+ 签发通配符 */
  async ensure(): Promise<{ ok: boolean; error?: string }> {
    if (!fs.existsSync(this.d.mkcertPath)) return { ok: false, error: 'mkcert.exe 缺失' }
    fs.mkdirSync(this.d.caroot, { recursive: true })
    fs.mkdirSync(this.d.certDir, { recursive: true })
    // 已存在 rootCA 则跳过 -install（避免重复 UAC）
    if (!fs.existsSync(path.join(this.d.caroot, 'rootCA.pem'))) {
      const r = await this.d.run(this.d.mkcertPath, ['-install'], this.env())
      if (r.code !== 0) return { ok: false, error: `mkcert -install 失败(exit ${r.code}): ${r.stderr.slice(-300)}` }
    }
    if (!fs.existsSync(this.certFile) || !fs.existsSync(this.keyFile)) {
      const dom = `*${this.d.suffix}`
      const r = await this.d.run(this.d.mkcertPath,
        ['-cert-file', this.certFile, '-key-file', this.keyFile, dom, this.d.suffix.slice(1)], this.env())
      if (r.code !== 0) return { ok: false, error: `mkcert 签发失败(exit ${r.code}): ${r.stderr.slice(-300)}` }
    }
    return { ok: true }
  }

  load(): { key: string; cert: string } | null {
    try {
      return { key: fs.readFileSync(this.keyFile, 'utf8'), cert: fs.readFileSync(this.certFile, 'utf8') }
    } catch { return null }
  }

  /** 强制重签（删旧证后 ensure） */
  async renew(): Promise<{ ok: boolean; error?: string }> {
    fs.rmSync(this.certFile, { force: true })
    fs.rmSync(this.keyFile, { force: true })
    return this.ensure()
  }
}
