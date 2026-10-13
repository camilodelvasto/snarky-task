export interface ContentBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutRegions {
  feed: ContentBounds
  board: ContentBounds
}

export const IPC = {
  REGIONS: 'layout:regions'
} as const
