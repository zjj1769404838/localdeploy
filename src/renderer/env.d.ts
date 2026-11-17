/// <reference types="vite/client" />
declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const c: DefineComponent<Record<string, unknown>, Record<string, unknown>, unknown>
  export default c
}

import type { AppState, IpcResult, LogLine, Settings, Project } from '@shared/types'

declare global {
  interface Window {
    localdeploy: {
      invoke(channel: string, ...args: unknown[]): Promise<IpcResult<unknown>>
      onState(cb: (s: AppState) => void): () => void
    }
  }
}
export {}
