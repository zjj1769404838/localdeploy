// 项目类型自动识别（Q23 智能向导）
import * as fs from 'node:fs'
import * as path from 'node:path'
import { ProjectType, DetectResult } from '@shared/types'

export type { DetectResult }

const STATIC_DIRS = ['dist', 'build', 'out', 'public']

/** 目录静态特征探测：优先静态产物，其次按入口文件推断进程命令 */
export function detectProject(dir: string): DetectResult | null {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return null
  const has = (p: string) => fs.existsSync(path.join(dir, p))

  // package.json → node 项目（有构建产物目录则按静态托管，否则按进程）
  let pkg: Record<string, unknown> | null = null
  if (has('package.json')) {
    try { pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) } catch { pkg = null }
  }

  for (const sd of STATIC_DIRS) {
    const full = path.join(dir, sd)
    if (fs.existsSync(full) && fs.statSync(full).isDirectory() && fs.existsSync(path.join(full, 'index.html'))) {
      return { type: 'static', dir: full, spa: true, hint: `发现 ${sd}/index.html，按静态站点托管` }
    }
  }

  if (pkg) {
    const scripts = (pkg.scripts ?? {}) as Record<string, string>
    const sc: [string, string[]] | null = scripts.start ? ['npm', ['run', 'start']] : scripts.dev ? ['npm', ['run', 'dev']] : null
    // 纯 node 入口
    if (!sc && typeof pkg.main === 'string' && has(pkg.main)) {
      return { type: 'process', command: 'node', args: [pkg.main], cwd: dir, port: guessPort(dir), hint: `入口 ${pkg.main}` }
    }
    if (sc) {
      return { type: 'process', command: sc[0], args: sc[1], cwd: dir, port: guessPort(dir), hint: 'package.json scripts' }
    }
  }

  // Java
  const jars = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.jar'))
  if (jars.length) {
    const jar = jars.sort()[0]!
    return { type: 'process', command: 'java', args: ['-jar', jar], cwd: dir, port: guessPort(dir), hint: `发现 ${jar}` }
  }
  // Python
  if (has('main.py')) return { type: 'process', command: 'python', args: ['main.py'], cwd: dir, port: guessPort(dir), hint: 'main.py' }
  if (has('app.py')) return { type: 'process', command: 'python', args: ['app.py'], cwd: dir, port: guessPort(dir), hint: 'app.py' }
  if (has('manage.py')) return { type: 'process', command: 'python', args: ['manage.py', 'runserver'], cwd: dir, port: 8000, hint: 'Django manage.py' }
  // Go
  if (has('main.go')) return { type: 'process', command: 'go', args: ['run', '.'], cwd: dir, port: guessPort(dir), hint: 'main.go' }
  const exes = fs.readdirSync(dir).filter(f => /^[a-z0-9_-]+\.exe$/i.test(f))
  if (exes.length) return { type: 'process', command: '.\\' + exes.sort()[0], args: [], cwd: dir, port: guessPort(dir), hint: '可执行文件' }

  return null
}

/** 从常见配置里猜端口（vite/next/express .env）；猜不到 undefined */
function guessPort(dir: string): number | undefined {
  try {
    for (const f of ['.env', 'vite.config.ts', 'vite.config.js', 'next.config.js']) {
      const fp = path.join(dir, f)
      if (!fs.existsSync(fp)) continue
      const t = fs.readFileSync(fp, 'utf8')
      const m = t.match(/port\D{0,3}(\d{2,5})/i)
      if (m && m[1]) { const p = Number(m[1]); if (p >= 1 && p <= 65535) return p }
    }
  } catch { /* ignore */ }
  return undefined
}
