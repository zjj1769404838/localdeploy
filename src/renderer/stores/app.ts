import { reactive } from 'vue'
import type { AppState, IpcResult, Project, Settings, LogLine, DetectResult } from '@shared/types'

export interface Store {
  state: AppState | null
  error: string | null
  ready: boolean
}

export const store = reactive<Store>({ state: null, error: null, ready: false })

async function call<T>(ch: string, ...args: unknown[]): Promise<T> {
  const r = (await window.localdeploy.invoke(ch, ...args)) as IpcResult<T>
  if (!r.ok) throw new Error(r.message ?? r.code ?? 'IPC 失败')
  return r.data as T
}

export const api = {
  async refresh(): Promise<void> {
    try {
      store.state = await call<AppState>('state:get')
      store.ready = true
      store.error = null
    } catch (e) { store.error = String((e as Error).message) }
  },
  detect: (dir: string) => call<DetectResult | null>('project:detect', dir),
  addProject: (spec: Partial<Project> & { name: string; type: Project['type'] }) => call<Project>('project:add', spec),
  updateProject: (id: string, patch: Partial<Project>) => call<Project>('project:update', id, patch),
  removeProject: (id: string) => call<null>('project:remove', id),
  start: (id: string) => call<string>('project:start', id),
  stop: (id: string) => call<string>('project:stop', id),
  restart: (id: string) => call<string>('project:restart', id),
  logs: (id: string, sinceSeq = 0) => call<{ lines: LogLine[]; eof: boolean }>('logs:get', id, sinceSeq),
  clearLogs: (id: string) => call<null>('logs:clear', id),
  updateSettings: (p: Partial<Settings>) => call<Settings>('settings:update', p),
  hostsRetry: () => call<null>('hosts:retry'),
  certsStatus: () => call<{ installed: boolean }>('certs:status'),
  certsRenew: () => call<unknown>('certs:renew'),
  autostartSet: (enabled: boolean) => call<boolean>('autostart:set', enabled),
  openExternal: (url: string) => call<unknown>('app:openExternal', url),
  quit: () => call<unknown>('app:quit')
}

export function subscribe(): void {
  window.localdeploy.onState((s) => { store.state = s })
}
