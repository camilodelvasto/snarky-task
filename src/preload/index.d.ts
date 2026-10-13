import type { TaskdeckAPI } from './index'

declare global {
  interface Window {
    taskdeck: TaskdeckAPI
  }
}
