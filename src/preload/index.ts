// Preload：contextBridge 白名单（docs/03 §2）
import { contextBridge, ipcRenderer } from 'electron'

const INVOKE_CHANNELS = [
  'state:get', 'project:detect', 'project:add', 'project:update', 'project:remove',
  'project:start', 'project:stop', 'project:restart',
  'logs:get', 'logs:clear', 'settings:update', 'hosts:retry',
  'certs:status', 'certs:renew', 'autostart:set', 'app:openExternal', 'app:quit', 'window:show'
] as const

const api = {
  invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    if (!(INVOKE_CHANNELS as readonly string[]).includes(channel)) {
      return Promise.reject(new Error(`IPC channel not allowed: ${channel}`))
    }
    return ipcRenderer.invoke(channel, ...args)
  },
  onState(cb: (s: unknown) => void): () => void {
    const h = (_e: unknown, s: unknown): void => cb(s)
    ipcRenderer.on('state:patch', h)
    return () => ipcRenderer.removeListener('state:patch', h)
  }
}

contextBridge.exposeInMainWorld('localdeploy', api)

export type LocalDeployApi = typeof api
