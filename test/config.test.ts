import { describe, it, expect } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import yaml from 'js-yaml'
import { validateConfig, ConfigStore, ConfigError } from '@engine/config'
import { defaultConfig } from '@shared/types'

function tmp(): string { return fs.mkdtempSync(path.join(os.tmpdir(), 'ld-cfg-')) }

describe('validateConfig', () => {
  it('默认配置合法', () => {
    const c = validateConfig(defaultConfig())
    expect(c.settings.gateway.httpPort).toBe(80)
    expect(c.projects).toEqual([])
  })
  it('拒绝非法 port', () => {
    const c = defaultConfig()
    c.settings.gateway.httpPort = 70000
    expect(() => validateConfig(c)).toThrow(ConfigError)
  })
  it('拒绝未知 version', () => {
    const c = defaultConfig()
    c.version = 2
    expect(() => validateConfig(c)).toThrow(/version/)
  })
  it('静态项目必须有 dir', () => {
    const c = defaultConfig()
    c.projects = [{ id: 'p-aaa111', name: 'x', domain: '', type: 'static', autoStart: false, restartOnCrash: null } as never]
    expect(() => validateConfig(c)).toThrow(/dir/)
  })
  it('进程项目必须有合法 port 与 command', () => {
    const c = defaultConfig()
    c.projects = [{ id: 'p-aaa111', name: 'x', domain: '', type: 'process', command: 'node', args: [], port: 0, autoStart: false, restartOnCrash: null } as never]
    expect(() => validateConfig(c)).toThrow(/port/)
  })
  it('域名重复拒绝', () => {
    const c = defaultConfig()
    c.projects = [
      { id: 'p-aaa111', name: 'a', domain: 'a.zjj', type: 'static', dir: 'C:\\x', autoStart: false, restartOnCrash: null },
      { id: 'p-bbb222', name: 'a2', domain: 'a.zjj', type: 'static', dir: 'C:\\y', autoStart: false, restartOnCrash: null }
    ]
    expect(() => validateConfig(c)).toThrow(/域名重复/)
  })
  it('domain 格式非法拒绝', () => {
    const c = defaultConfig()
    c.projects = [{ id: 'p-aaa111', name: 'a', domain: 'Bad Name.zjj', type: 'static', dir: 'C:\\x', autoStart: false, restartOnCrash: null } as never]
    expect(() => validateConfig(c)).toThrow(/domain/)
  })
})

describe('ConfigStore', () => {
  it('不存在时生成默认文件', () => {
    const d = tmp()
    const fp = path.join(d, 'config.yaml')
    const st = new ConfigStore({ configPath: fp })
    st.load()
    expect(fs.existsSync(fp)).toBe(true)
    const parsed = yaml.load(fs.readFileSync(fp, 'utf8')) as { version: number }
    expect(parsed.version).toBe(1)
  })
  it('save 后 reloadIfChanged 检出外部编辑', () => {
    const d = tmp()
    const fp = path.join(d, 'config.yaml')
    const st = new ConfigStore({ configPath: fp })
    st.load()
    const next = structuredClone(st.current)
    next.settings.gateway.httpPort = 8080
    st.save(next)
    expect(st.current.settings.gateway.httpPort).toBe(8080)
    // 模拟外部编辑（mtime 变化）
    const raw = yaml.load(fs.readFileSync(fp, 'utf8')) as Record<string, unknown>
    const raw2 = { ...(raw as object), settings: { ...(raw as { settings: Record<string, unknown> }).settings, domain: { suffix: '.test', hostsManaged: false } } } as Record<string, unknown>
    fs.writeFileSync(fp, yaml.dump(raw2))
    let changed = false
    st.onChange = () => { changed = true }
    // 绕过 mtime 粒度：改 size 也变 hash
    expect(st.reloadIfChanged()).toBe(true)
    expect(changed).toBe(true)
  })
  it('解析失败保留旧配置并回调错误', () => {
    const d = tmp()
    const fp = path.join(d, 'config.yaml')
    const st = new ConfigStore({ configPath: fp })
    st.load()
    fs.writeFileSync(fp, 'version: !!\n  bad: [')
    let errSeen: Error | null = null
    st.onParseError = (e) => { errSeen = e }
    expect(st.reloadIfChanged()).toBe(false)
    expect(errSeen).not.toBeNull()
    expect(st.current.settings.gateway.httpPort).toBe(80)
  })
})
