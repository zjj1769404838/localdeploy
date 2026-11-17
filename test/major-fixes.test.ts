// M4/M5 major 修复的回归固化
import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
import { applyBlock, HostsManager, HostsIO } from '@engine/hosts'
import { Engine } from '@engine'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ld-maj-')) }

describe('M4 applyBlock replace 语义', () => {
  it('replace 全量替换区块：旧域被清掉', () => {
    const base = applyBlock('127.0.0.1 localhost\n', [{ domain: 'a.zjj', op: 'add' }, { domain: 'b.zjj', op: 'add' }])
    if (!base.ok) throw new Error('base')
    const rep = applyBlock(base.text, [{ domain: 'c.zjj', op: 'add' }], true)
    if (!rep.ok) throw new Error('rep')
    expect(rep.text).toContain('c.zjj')
    expect(rep.text).not.toContain('a.zjj')
    expect(rep.text).not.toContain('b.zjj')
    expect(rep.text).toContain('127.0.0.1 localhost') // 区块外保留
  })
  it('replace 空集删空区块', () => {
    const base = applyBlock('', [{ domain: 'a.zjj', op: 'add' }])
    if (!base.ok) throw new Error('base')
    const rep = applyBlock(base.text, [], true)
    if (!rep.ok) throw new Error('rep')
    expect(rep.text).not.toContain('a.zjj')
  })
  it('HostsManager.apply(entries, true) 走 replace', async () => {
    const d = tmp()
    const fp = path.join(d, 'hosts')
    fs.writeFileSync(fp, '127.0.0.1 localhost\n')
    const hm = new HostsManager({ hostsPath: fp })
    await hm.apply([{ domain: 'gone.zjj', op: 'add' }])
    const r = await hm.apply([{ domain: 'keep.zjj', op: 'add' }], true)
    expect(r.ok).toBe(true)
    expect(fs.readFileSync(fp, 'utf8')).not.toContain('gone.zjj')
    expect(fs.readFileSync(fp, 'utf8')).toContain('keep.zjj')
  })
})

describe('M5 settings:update 深合并', () => {
  it('partial patch 保留缺节现值', async () => {
    const d = tmp()
    const eng = new Engine({ dataDir: d, hostsPath: path.join(d, 'hosts'), elevate: null, procShell: false })
    // 先写一个非默认值到 proc.maxRestarts
    const r1 = await eng.apiSettingsUpdate({ proc: { restartOnCrash: true, backoffBaseMs: 2000, backoffCapMs: 40000, maxRestarts: 9, killTimeoutMs: 10000 } })
    expect(r1.ok).toBe(true)
    // 只 patch gateway 一节
    const r2 = await eng.apiSettingsUpdate({ gateway: { httpPort: 8080, httpsPort: 443, httpsEnabled: false, httpsRedirect: true } })
    expect(r2.ok).toBe(true)
    expect(eng.state().settings.proc.maxRestarts).toBe(9) // 不被回落为默认 5
    expect(eng.state().settings.gateway.httpPort).toBe(8080)
    const onDisk = yaml.load(fs.readFileSync(path.join(d, 'config.yaml'), 'utf8')) as { settings: { proc: { maxRestarts: number } } }
    expect(onDisk.settings.proc.maxRestarts).toBe(9)
  })
})
