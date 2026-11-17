import { describe, it, expect } from 'vitest'
import { LogHub } from '@engine/logs'
import { ProcMan } from '@engine/procman'
import { defaultConfig, Project } from '@shared/types'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const logSettings = defaultConfig().settings.logs
const procSettings = defaultConfig().settings.proc

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ld-log-')) }

describe('LogHub', () => {
  it('环形上限截断且 seq 单调', () => {
    const h = new LogHub({ ...logSettings, ringLines: 5 })
    for (let i = 0; i < 10; i++) h.push('l' + i, 'out')
    const { lines } = h.get(0)
    expect(lines.length).toBe(5)
    expect(lines[0]!.line).toBe('l5')
    expect(lines[4]!.seq).toBe(10)
  })
  it('sinceSeq 增量读取', () => {
    const h = new LogHub(logSettings)
    h.push('a', 'out'); h.push('b', 'err')
    const r1 = h.get(1)
    expect(r1.lines.map(l => l.line)).toEqual(['b'])
    expect(r1.eof).toBe(true)
  })
  it('落盘滚动：超限后产生 .1/.2 且封顶 fileKeep', () => {
    const d = tmp()
    const h = new LogHub({ ringLines: 100000, fileSizeMb: 0.0001, fileKeep: 3 }) // ~105 bytes
    h.attachFile(d, 'p-x')
    for (let i = 0; i < 200; i++) h.push('x'.repeat(60), 'out')
    h.closeFile()
    const files = fs.readdirSync(d)
    expect(files).toContain('p-x.log.1')
    expect(files).toContain('p-x.log.2')
    // 当前 .log 可能因末次写入恰好触发轮转而不存在，存在则合规
    for (const f of files) expect(f.startsWith('p-x.log')).toBe(true)
  })
})

function mkProc(over: Partial<Project> = {}): Project {
  return { id: 'p-test01', name: 't', domain: '', type: 'process', command: 'node', args: [], cwd: undefined, port: 3999, autoStart: false, restartOnCrash: null, ...over }
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('ProcMan 状态机', () => {
  it('spawn 短命令：running → stopped', async () => {
    const pm = new ProcMan(procSettings, { shell: false })
    const hub = new LogHub(logSettings)
    const p = mkProc({ args: ['-e', 'setInterval(()=>{},1000)'] })
    pm.register(p, hub)
    await pm.start(p.id)
    expect(pm.get(p.id)!.status).toBe('running')
    await pm.stop(p.id)
    expect(pm.get(p.id)!.status).toBe('stopped')
  })

  it('立即退出触发退避重启计数，desired=false 停止后不重启', async () => {
    const fast: typeof procSettings = { ...procSettings, backoffBaseMs: 100, maxRestarts: 2 }
    const pm = new ProcMan(fast, { shell: false })
    const hub = new LogHub(logSettings)
    const p = mkProc({ args: ['-e', 'process.exit(3)'] })
    pm.register(p, hub)
    const statuses: string[] = []
    pm.on('status', (_id, s) => statuses.push(s))
    await pm.start(p.id).catch(() => { /* 立即退出 reject 属预期 */ })
    await sleep(700)
    await pm.stop(p.id)
    // 至少经历 starting/running→starting(重启)
    expect(statuses.length).toBeGreaterThan(1)
    expect(pm.get(p.id)!.desired).toBe(false)
  })

  it('连败超限 → crashed', async () => {
    const fast: typeof procSettings = { ...procSettings, backoffBaseMs: 50, backoffCapMs: 60, maxRestarts: 1 }
    const pm = new ProcMan(fast, { shell: false })
    const p = mkProc({ args: ['-e', 'process.exit(1)'] })
    pm.register(p, new LogHub(logSettings))
    await pm.start(p.id).catch(() => undefined)
    await sleep(800)
    expect(pm.get(p.id)!.status).toBe('crashed')
  })

  it('命令不存在：spawn error 走 crashed（maxRestarts=0）', async () => {
    const pm = new ProcMan({ ...procSettings, maxRestarts: 0 }, { shell: false })
    const p = mkProc({ command: 'definitely-not-a-real-cmd-xyz' })
    pm.register(p, new LogHub(logSettings))
    await pm.start(p.id).catch(() => undefined)
    await sleep(400)
    expect(['crashed', 'starting']).toContain(pm.get(p.id)!.status)
    expect(pm.get(p.id)!.status).toBe('crashed')
  })
})
