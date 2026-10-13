import { contextBridge, ipcRenderer } from 'electron'
import { IPC, LayoutRegions } from '../shared/types'

const api = {
  sendRegions: (regions: LayoutRegions): void => {
    ipcRenderer.send(IPC.REGIONS, regions)
  }
}

export type TaskdeckAPI = typeof api
contextBridge.exposeInMainWorld('taskdeck', api)
