// 网关：按 Host 分流反代 + HTTPS + 301（docs/02 §3.3）
import * as http from 'node:http'
import * as https from 'node:https'
import * as net from 'node:net'
import { AddressInfo } from 'node:net'
import { serveStatic } from './staticsrv'

export interface Route {
  domain: string          // shili.zjj
  type: 'static' | 'proxy'
  root?: string           // static
  spa?: boolean
  port?: number           // proxy 上游端口
}

export interface GatewayOptions {
  httpPort: number
  httpsPort: number
  httpsEnabled: boolean
  httpsRedirect: boolean
  cert?: { key: string; cert: string } | null
  onError?: (err: Error) => void
}

export type GatewayState = { running: boolean; httpPort: number; httpsPort: number; httpsActive: boolean; error?: string }

function hostOf(req: http.IncomingMessage): string {
  const h = (req.headers.host ?? '').toLowerCase()
  const i = h.lastIndexOf(':')
  // IPv6 字面量含冒号；简单处理：若 [ 开头用 ] 截
  if (h.startsWith('[')) { const j = h.indexOf(']'); return j >= 0 ? h.slice(0, j + 1) : h }
  return i >= 0 ? h.slice(0, i) : h
}

export class Gateway {
  private routes = new Map<string, Route>()
  private servers: http.Server[] = []
  private httpsSrv: https.Server | null = null
  state: GatewayState
  private opts: GatewayOptions

  constructor(opts: GatewayOptions) {
    this.opts = opts
    this.state = { running: false, httpPort: opts.httpPort, httpsPort: opts.httpsPort, httpsActive: false }
  }

  setRoutes(routes: Route[]): void {
    this.routes = new Map(routes.map(r => [r.domain.toLowerCase(), r]))
  }

  getRoute(host: string): Route | undefined {
    return this.routes.get(host.toLowerCase())
  }

  /** 返回 EADDRINUSE 等错误（仅提示不回退，Q19） */
  async start(): Promise<GatewayState> {
    await this.stop()
    const { httpPort, httpsPort, httpsEnabled, httpsRedirect, cert } = this.opts
    try {
      const srv = http.createServer((req, res) => this.handle(req, res, false, httpPort))
      this.attachWs(srv)
      await this.listen(srv, httpPort, '127.0.0.1')
      this.servers.push(srv)
      if (httpsEnabled && cert) {
        try {
          const s = https.createServer({ key: cert.key, cert: cert.cert }, (req, res) => this.handle(req, res, true, httpsPort))
          this.attachWs(s)
          await this.listen(s, httpsPort, '127.0.0.1')
          this.httpsSrv = s
          this.state.httpsActive = true
        } catch (e) {
          this.opts.onError?.(e as Error)
          this.state.httpsActive = false
          this.state.error = `HTTPS 启动失败（已降级 HTTP）: ${(e as Error).message}`
        }
      }
      if (httpsEnabled && httpsRedirect && this.state.httpsActive) this.redirectHttp = true
      this.state.running = true
      this.state.httpPort = (this.servers[0]!.address() as AddressInfo).port
      return this.state
    } catch (e) {
      this.state = { running: false, httpPort, httpsPort, httpsActive: false, error: (e as Error).message }
      return this.state
    }
  }
  private redirectHttp = false

  private listen(srv: http.Server | https.Server, port: number, host: string): Promise<void> {
    return new Promise((res, rej) => {
      srv.once('error', rej)
      srv.listen(port, host, () => { srv.removeListener('error', rej); res() })
    })
  }

  /** WebSocket/CONNECT 透传：按 Host 找 proxy 路由 */
  private attachWs(srv: http.Server | https.Server): void {
    srv.on('upgrade', (req: http.IncomingMessage, socket: net.Socket, head: Buffer) => {
      const route = this.routes.get(hostOf(req))
      if (route?.type !== 'proxy' || !route.port) { socket.destroy(); return }
      const up = net.connect(route.port, '127.0.0.1', () => {
        const lines = [`${req.method} ${req.url} HTTP/1.1`]
        for (let k = 0; k < req.rawHeaders.length; k += 2) lines.push(`${req.rawHeaders[k]}: ${req.rawHeaders[k + 1]}`)
        socket.write(lines.join('\r\n') + '\r\n\r\n')
        if (head.length) socket.write(head)
        socket.pipe(up); up.pipe(socket)
      })
      up.on('error', () => socket.destroy())
      socket.on('error', () => up.destroy())
    })
  }

  private handle(req: http.IncomingMessage, res: http.ServerResponse, isHttps: boolean, myPort: number): void {
    const host = hostOf(req)
    const route = this.routes.get(host)
    if (!route) {
      // 未知域名：本机直连放行到默认页（提示），其余 404
      if (host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || host === '::1') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end('<!doctype html><meta charset="utf-8"><title>LocalDeploy</title><p>LocalDeploy 网关运行中。请在管理界面添加项目域名。</p>')
        return
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`404 — 域名未注册: ${host}`)
      return
    }
    // HTTP→HTTPS 301（仅 httpsRedirect 且当前为 http）
    if (!isHttps && this.redirectHttp && this.opts.httpsEnabled && this.state.httpsActive) {
      const p = this.state.httpsPort === 443 ? '' : `:${this.state.httpsPort}`
      res.writeHead(301, { location: `https://${host}${p}${req.url ?? '/'}` })
      res.end()
      return
    }
    if (route.type === 'static' && route.root) {
      serveStatic(req, res, { root: route.root, spa: route.spa ?? true })
      return
    }
    if (route.type === 'proxy' && route.port) {
      this.proxyTo(req, res, route.port)
      return
    }
    res.writeHead(502)
    res.end('502 上游未配置')
  }

  private proxyTo(req: http.IncomingMessage, res: http.ServerResponse, upstreamPort: number): void {
    const preq = http.request(
      { host: '127.0.0.1', port: upstreamPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${upstreamPort}` } },
      (pres) => {
        res.writeHead(pres.statusCode ?? 502, pres.headers)
        pres.pipe(res)
      }
    )
    preq.on('error', (e) => {
      res.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' })
      res.end(`502 Bad Gateway — 上游不可达 (${upstreamPort}): ${e.message}`)
    })
    req.pipe(preq)
  }

  async stop(): Promise<void> {
    const all: (http.Server | https.Server)[] = [...this.servers]
    if (this.httpsSrv) all.push(this.httpsSrv)
    this.servers = []
    this.httpsSrv = null
    await Promise.all(all.map(s => new Promise<void>(r => s.close(() => r()))))
    this.state.running = false
    this.state.httpsActive = false
    this.redirectHttp = false
  }
}
