// js-yaml 本地类型 shim（避免与 electron-builder peer 树的 npm 冲突）
declare module 'js-yaml' {
  export function load(text: string, opts?: Record<string, unknown>): unknown
  export function dump(obj: unknown, opts?: Record<string, unknown>): string
}
