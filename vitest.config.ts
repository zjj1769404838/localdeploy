import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@engine': resolve(__dirname, 'src/main/engine')
    }
  },
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 20000
  }
})
