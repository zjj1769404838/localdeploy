// S7 端到端演练：真实 Engine（子进程 + HTTP + hosts 桩），非特权端口，禁碰真机（PLAN 硬约束）
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import * as http from 'node:http'
import yaml from 'js-yaml'
import { Engine } from '@engine'
import { defaultConfig } from '@shared/types'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function get(url: string, host?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: host ? { host } : {} }, res => {
      let b = ''
      res.on('data', c => (b += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b }))
    })
    req.on('error', reject)
  })
}

const report: Record<string, unknown> = {}

describe('E2E drill', () => {
  it('全生命周期：添加→域名访问→崩溃重启→停止→日志→hosts 降级→状态恢复', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-e2e-'))
    const hostsFile = path.join(root, 'hosts')
    fs.writeFileSync(hostsFile, '127.0.0.1 localhost\n')
    // 静态目录
    const web = path.join(root, 'web')
    fs.mkdirSync(web)
    fs.writeFileSync(path.join(web, 'index.html'), '<h1>E2E-STATIC</h1>')
    // 后端脚本：打印一行后按 crash 标记退出
    const srv = path.join(root, 'srv.js')
    const marker = path.join(root, 'crash-once')
    fs.writeFileSync(srv, `
      const http = require('node:http')
      console.log('srv up')
      if (!require('node:fs').existsSync(${JSON.stringify(marker)})) {
        require('node:fs').writeFileSync(${JSON.stringify(marker)}, '1')
        process.exit(7) // 首次崩溃
      }
      http.createServer((q,s)=>{ s.end('E2E-API:' + q.url) }).listen(Number(process.env.E2E_PORT))
    `)

    const eng = new Engine({
      dataDir: root,
      hostsPath: hostsFile,
      elevate: null, // 演练不弹 UAC；无提权 → 权限路径直接降级
      procShell: false
    })
    // 端口配置为非特权随机段
    const cfg = defaultConfig()
    cfg.settings.gateway.httpPort = 18081
    cfg.settings.autostart.resumeProjects = true
    fs.writeFileSync(path.join(root, 'config.yaml'), yaml.dump(cfg))
    await eng.boot()

    // 1. 添加静态项目
    const stA = await eng.apiProjectAdd({ name: 'E2E 前端', type: 'static', dir: web, spa: true })
    expect(stA.ok).toBe(true)
    const domainA = (stA.data as { domain: string }).domain
    expect(domainA).toBe('e2e.zjj') // 中文被折叠，slug 仅 ASCII
    report.staticDomain = domainA
    // 2. 添加后端进程项目
    const stB = await eng.apiProjectAdd({
      name: 'e2e-api', type: 'process', command: process.execPath, args: [srv],
      cwd: root, port: 18090, env: { E2E_PORT: '18090' }, autoStart: true
    })
    expect(stB.ok).toBe(true)
    const idB = (stB.data as { id: string }).id
    // 启动（第一次会崩溃退 7 → 退避重启；脚本二次运行不崩）
    await eng.apiProjectStart(idB)
    await sleep(3500) // 等退避(1s)+重启完成
    const s1 = eng.state().projects.find(p => p.project.id === idB)
    report.afterCrash = { status: s1?.status, restarts: s1?.restartsInFlight }
    expect(['running', 'starting']).toContain(s1?.status)
    await waitRunning(eng, idB)

    // 3. HTTP 经网关按域名访问
    const rA = await get('http://127.0.0.1:18081/', domainA)
    expect(rA.body).toContain('E2E-STATIC')
    const rB = await get('http://127.0.0.1:18081/hello', 'e2e-api.zjj')
    expect(rB.body).toBe('E2E-API:/hello')
    report.httpViaGateway = { static: rA.status, proxy: rB.status }

    // 4. 端口直连
    const rC = await get('http://127.0.0.1:18090/direct')
    expect(rC.body).toBe('E2E-API:/direct')

    // 5. 日志可见（含崩溃记录）
    const logs = eng.apiLogsGet(idB, 0)
    const lines = (logs.data as { lines: { line: string }[] }).lines.map(l => l.line)
    report.logLines = lines.length
    expect(lines.some(l => l.includes('srv up'))).toBe(true)
    expect(lines.some(l => l.includes('restart'))).toBe(true)

    // 6. hosts 写失败 → 降级不阻塞（Windows chmod 无写保护语义：用目录占据路径强制失败）
    const hostsBackup = fs.readFileSync(hostsFile, 'utf8')
    fs.rmSync(hostsFile)
    fs.mkdirSync(hostsFile)
    const r = await eng.apiHostsRetry()
    const st2 = eng.state()
    const hostWarn = st2.warnings.find(w => w.code === 'W_HOSTS_DENIED')
    report.hostsDegraded = !!hostWarn
    expect(hostWarn).toBeTruthy()
    // 项目仍运行（降级不阻塞）
    expect(eng.state().projects.find(p => p.project.id === idB)?.status).toBe('running')
    fs.rmSync(hostsFile, { recursive: true })
    fs.writeFileSync(hostsFile, hostsBackup)
    void r

    // 7. 停止
    await eng.apiProjectStop(idB)
    expect(eng.state().projects.find(p => p.project.id === idB)?.status).toBe('stopped')

    // 8. 状态恢复：新 Engine 实例读同一 dataDir，autoStart 项目恢复拉起
    await eng.shutdown()
    const eng2 = new Engine({ dataDir: root, hostsPath: hostsFile, elevate: null, procShell: false })
    await eng2.boot()
    await waitRunning(eng2, idB)
    const s2 = eng2.state().projects.find(p => p.project.id === idB)
    report.resume = s2?.status
    expect(s2?.status).toBe('running')
    let r2 = { status: 0, body: '' }
    for (let i = 0; i < 20; i++) {
      try { r2 = await get('http://127.0.0.1:18081/resume', 'e2e-api.zjj') } catch { /* retry */ }
      if (r2.body === 'E2E-API:/resume') break
      await sleep(250)
    }
    expect(r2.body).toBe('E2E-API:/resume')
    await eng2.shutdown()

    fs.writeFileSync(path.join(root, 'e2e-report.json'), JSON.stringify(report, null, 2))
    console.log('E2E_REPORT', JSON.stringify(report))
    console.log('E2E_REPORT_PATH', path.join(root, 'e2e-report.json'))
  }, 60000)
})

async function waitRunning(eng: Engine, id: string): Promise<void> {
  for (let i = 0; i < 40; i++) {
    if (eng.state().projects.find(p => p.project.id === id)?.status === 'running') return
    await sleep(250)
  }
  throw new Error('timeout waiting running: ' + JSON.stringify(eng.state().projects.find(p => p.project.id === id)))
}
