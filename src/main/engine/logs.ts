// 日志：内存环形 + 落盘滚动（docs/03 §1 logs 契约）
import * as fs from 'node:fs'
import * as path from 'node:path'
import { LogLine, LogSettings } from '@shared/types'

export class LogHub {
  private ring: LogLine[] = []
  private seq = 0
  private filePath = ''
  private bytesWritten = 0
  private settings: LogSettings

  constructor(settings: LogSettings) {
    this.settings = settings
  }

  updateSettings(s: LogSettings): void {
    this.settings = s
    // 截断超出新上限的环形区
    if (this.ring.length > s.ringLines) this.ring = this.ring.slice(-s.ringLines)
  }

  /** 开启落盘（dir/logs/<projectId>.log）。dir 由调用方注入（%APPDATA% 或临时目录） */
  attachFile(dir: string, projectId: string): void {
    fs.mkdirSync(dir, { recursive: true })
    this.filePath = path.join(dir, `${projectId}.log`)
    try {
      this.bytesWritten = fs.statSync(this.filePath).size
    } catch { this.bytesWritten = 0 }
  }

  closeFile(): void {
    this.filePath = ''
  }

  push(line: string, stream: 'out' | 'err'): LogLine {
    const rec: LogLine = { seq: ++this.seq, t: new Date().toISOString(), line, stream }
    this.ring.push(rec)
    if (this.ring.length > this.settings.ringLines) this.ring.splice(0, this.ring.length - this.settings.ringLines)
    if (this.filePath) {
      const text = `[${rec.t}] [${stream}] ${line}\n`
      try {
        fs.appendFileSync(this.filePath, text, 'utf8')
        this.bytesWritten += Buffer.byteLength(text)
        this.rotateIfNeeded()
      } catch { /* 磁盘错误不影响内存日志 */ }
    }
    return rec
  }

  private rotateIfNeeded(): void {
    const max = Math.round(this.settings.fileSizeMb * 1024 * 1024)
    if (this.bytesWritten < max || !this.filePath) return
    // <name>.log.N-1 -> .N（新在前：.1 最近）
    for (let i = this.settings.fileKeep - 1; i >= 1; i--) {
      const src = `${this.filePath}.${i}`
      if (fs.existsSync(src)) {
        if (i + 1 > this.settings.fileKeep) fs.rmSync(src, { force: true })
        else fs.renameSync(src, `${this.filePath}.${i + 1}`)
      }
    }
    fs.rmSync(`${this.filePath}.${this.settings.fileKeep}`, { force: true })
    fs.renameSync(this.filePath, `${this.filePath}.1`)
    this.bytesWritten = 0
  }

  /** sinceSeq 之后的行（不含 sinceSeq） */
  get(sinceSeq = 0, limit = 500): { lines: LogLine[]; eof: boolean } {
    const start = this.ring.findIndex(l => l.seq > sinceSeq)
    if (start === -1) {
      // sinceSeq 比全环都新（或环为空且无新行）
      return { lines: [], eof: true }
    }
    const all = this.ring.slice(start)
    const lines = all.slice(0, limit)
    return { lines, eof: lines.length >= all.length }
  }

  clear(): void {
    this.ring = []
    if (this.filePath) {
      const fp = this.filePath
      for (let i = 1; i <= this.settings.fileKeep; i++) fs.rmSync(`${fp}.${i}`, { force: true })
      fs.rmSync(fp, { force: true })
      this.bytesWritten = 0
    }
  }
}
