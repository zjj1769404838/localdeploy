import { describe, it, expect } from 'vitest'
import * as http from 'node:http'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Gateway } from '@engine/gateway'
import { applyBlock, BEGIN, END, HostsManager, HostsIO } from '@engine/hosts'
import { pickStatic } from '@engine/staticsrv'
import { detectProject } from '@engine/detect'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

function get(url: string, host?: string): Promise<{ status: number; body: string; loc?: string }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    const req = http.get({ host: u.hostname, port: u.port, path: u.pathname, headers: host ? { host } : {} }, res => {
      let b = ''
      res.on('data', c => (b += c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: b, ...(res.headers.location ? { loc: res.headers.location } : {}) }))
    })
    req.on('error', reject)
  })
}

describe('Gateway 路由', () => {
  it('按 Host 分流静态与反代；未知域 404', async () => {
    // 上游
    const up = http.createServer((_q, s) => s.end('UPSTREAM'))
    await new Promise<void>(r => up.listen(0, '127.0.0.1', r))
    const upPort = (up.address() as { port: number }).port
    // 静态
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-web-'))
    fs.mkdirSync(path.join(d, 'assets'))
    fs.writeFileSync(path.join(d, 'index.html'), 'SPA-ROOT')
    fs.writeFileSync(path.join(d, 'assets', 'a.js'), 'JS')

    const gw = new Gateway({ httpPort: 0, httpsPort: 0, httpsEnabled: false, httpsRedirect: false })
    gw.setRoutes([
      { domain: 'a.zjj', type: 'static', root: d, spa: true },
      { domain: 'b.zjj', type: 'proxy', port: upPort }
    ])
    const st = await gw.start()
    expect(st.running).toBe(true)
    const base = `http://127.0.0.1:${st.httpPort}`
    expect((await get(base + '/', 'a.zjj')).body).toBe('SPA-ROOT')
    expect((await get(base + '/deep/route', 'a.zjj')).body).toBe('SPA-ROOT') // SPA 回退
    expect((await get(base + '/assets/a.js', 'a.zjj')).body).toBe('JS')
    expect((await get(base + '/', 'b.zjj')).body).toBe('UPSTREAM')
    expect((await get(base + '/', 'nope.zjj')).status).toBe(404)
    await gw.stop()
    up.close()
  })

  it('端口冲突仅提示不回退（Q19）', async () => {
    const blocker = http.createServer()
    await new Promise<void>(r => blocker.listen(0, '127.0.0.1', r))
    const port = (blocker.address() as { port: number }).port
    const gw = new Gateway({ httpPort: port, httpsPort: 0, httpsEnabled: false, httpsRedirect: false })
    const st = await gw.start()
    expect(st.running).toBe(false)
    expect(st.error).toMatch(/EADDRINUSE/)
    blocker.close()
  })
})

describe('hosts 区块', () => {
  const T = (lines: string[]) => lines.join('\n')
  it('空文件新增', () => {
    const r = applyBlock('127.0.0.1 localhost\n', [{ domain: 'a.zjj', op: 'add' }])
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.text).toContain('127.0.0.1 a.zjj')
      expect(r.text).toContain('::1 a.zjj')
      expect(r.text).toContain('127.0.0.1 localhost') // 区块外保留
    }
  })
  it('重复 apply 幂等', () => {
    const r1 = applyBlock('', [{ domain: 'a.zjj', op: 'add' }])
    expect(r1.ok).toBe(true)
    if (!r1.ok) return
    const r2 = applyBlock(r1.text, [{ domain: 'a.zjj', op: 'add' }])
    expect(r2.ok).toBe(true)
    if (r2.ok) expect(r2.text).toBe(r1.text)
  })
  it('remove 域', () => {
    const r1 = applyBlock('', [{ domain: 'a.zjj', op: 'add' }, { domain: 'b.zjj', op: 'add' }])
    if (!r1.ok) throw new Error('r1')
    const r2 = applyBlock(r1.text, [{ domain: 'a.zjj', op: 'remove' }])
    if (!r2.ok) throw new Error('r2')
    expect(r2.text).not.toContain('a.zjj')
    expect(r2.text).toContain('b.zjj')
  })
  it('标记重复视为损坏拒写', () => {
    const r = applyBlock(T([BEGIN, END, BEGIN, END]), [{ domain: 'x.zjj', op: 'add' }])
    expect(r.ok).toBe(false)
  })
  it('HostsManager 写失败 → 降级不抛', async () => {
    const io: HostsIO = {
      read: () => '',
      write: () => { const e = new Error('EACCES') as NodeJS.ErrnoException; e.code = 'EACCES'; throw e },
      exists: () => true
    }
    const hm = new HostsManager({ hostsPath: 'X:\\fake-hosts', io }) // 无 elevate → 直接降级
    const r = await hm.apply([{ domain: 'a.zjj', op: 'add' }])
    expect(r.ok).toBe(false)
    expect(r.degraded).toBe(true)
    expect(r.code).toBe('denied')
  })
})

describe('staticsrv 安全', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-st-'))
  fs.writeFileSync(path.join(d, 'index.html'), 'IDX')
  fs.writeFileSync(path.join(d, 'secret.txt'), 'S')
  it('越界路径不外泄：结果恒为 null 或 root 内文件', () => {
    const inRoot = (r: string | null) => r === null || r.startsWith(d + path.sep) || r === path.join(d, 'index.html')
    // normalize 后落在 root 内不存在的路径：spa 回退 index.html（不泄漏 root 外文件）
    expect(pickStatic(d, '/../etc/passwd', true)).toBe(path.join(d, 'index.html'))
    expect(inRoot(pickStatic(d, '/../etc/passwd', false))).toBe(true)
    expect(inRoot(pickStatic(d, '/%2e%2e/%2e%2e/windows', true))).toBe(true)
    expect(inRoot(pickStatic(d, '/a\0b', true))).toBe(true)
    expect(pickStatic(d, '/a\0b', true)).toBeNull()
  })
  it('spa 回退 / 非 spa 404', () => {
    expect(pickStatic(d, '/nope', true)).toBe(path.join(d, 'index.html'))
    expect(pickStatic(d, '/nope', false)).toBeNull()
  })
})

describe('detect', () => {
  it('dist+index.html → static', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-det-'))
    fs.mkdirSync(path.join(d, 'dist'))
    fs.writeFileSync(path.join(d, 'dist', 'index.html'), '')
    const r = detectProject(d)
    expect(r?.type).toBe('static')
    expect(r?.dir).toBe(path.join(d, 'dist'))
  })
  it('package.json scripts → npm run', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-det-'))
    fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ scripts: { start: 'node s.js' } }))
    const r = detectProject(d)
    expect(r?.type).toBe('process')
    expect(r?.command).toBe('npm')
    expect(r?.args).toEqual(['run', 'start'])
  })
  it('jar → java -jar', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-det-'))
    fs.writeFileSync(path.join(d, 'app.jar'), '')
    const r = detectProject(d)
    expect(r?.command).toBe('java')
    expect(r?.args).toEqual(['-jar', 'app.jar'])
  })
  it('无特征目录 → null；不存在 → null', () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ld-det-'))
    expect(detectProject(d)).toBeNull()
    expect(detectProject(path.join(d, 'nope'))).toBeNull()
  })
})
