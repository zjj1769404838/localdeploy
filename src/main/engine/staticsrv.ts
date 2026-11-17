// 静态伺服 + SPA 回退（零依赖，http 原语实现）
import * as fs from 'node:fs'
import * as path from 'node:path'
import { IncomingMessage, ServerResponse } from 'node:http'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
  '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.wasm': 'application/wasm'
}

export interface StaticServeOptions {
  root: string
  spa: boolean
}

/** 安全解析 URL 路径到 root 内文件；越界返回 null */
export function resolveStatic(root: string, urlPath: string): string | null {
  let decoded: string
  try { decoded = decodeURIComponent((urlPath.split('?')[0] ?? '/').split('#')[0] ?? '/') } catch { return null }
  if (decoded.includes('\0')) return null
  const clean = path.posix.normalize(decoded).replace(/^\/+/, '')
  const abs = path.resolve(root, clean)
  const rootAbs = path.resolve(root)
  if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return null // 越界
  return abs
}

/** 命中文件则返回路径；目录/未命中：root/index.html 兜底；spa 时任意未命中回 index.html */
export function pickStatic(root: string, urlPath: string, spa: boolean): string | null {
  const abs = resolveStatic(root, urlPath)
  if (!abs) return null
  try {
    const st = fs.statSync(abs)
    if (st.isDirectory()) {
      const idx = path.join(abs, 'index.html')
      if (fs.existsSync(idx)) return idx
      // 目录无 index：SPA 时回根 index，否则 404
      const rootIdx = path.join(root, 'index.html')
      if (spa && fs.existsSync(rootIdx)) return rootIdx
      return null
    }
    return abs
  } catch {
    if (spa) {
      const rootIdx = path.join(root, 'index.html')
      if (fs.existsSync(rootIdx)) return rootIdx
    }
    return null
  }
}

export function serveStatic(req: IncomingMessage, res: ServerResponse, opts: StaticServeOptions): void {
  const url = req.url ?? '/'
  const file = pickStatic(opts.root, url, opts.spa)
  if (!file) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('404 Not Found')
    return
  }
  const ext = path.extname(file).toLowerCase()
  const type = MIME[ext] ?? 'application/octet-stream'
  const cacheable = !file.endsWith('.html')
  res.writeHead(200, {
    'content-type': type,
    'cache-control': cacheable ? 'public, max-age=3600' : 'no-cache',
    'content-length': String(fs.statSync(file).size)
  })
  if (req.method === 'HEAD') { res.end(); return }
  fs.createReadStream(file).pipe(res)
}
