import { resolve } from 'path'
import { cpSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin(),
      {
        name: 'copy-task-schemas',
        closeBundle() {
          const from = resolve(__dirname, 'src/main/tasks/schema')
          const to = resolve(__dirname, 'out/main/schema')
          cpSync(from, to, { recursive: true })
        }
      }
    ]
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src')
      }
    }
  }
})
