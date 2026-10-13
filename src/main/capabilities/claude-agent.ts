import { spawn as nodeSpawn } from 'child_process'
import type { Agent } from './contracts'

export class ClaudeAgent implements Agent {
  constructor(private spawnImpl: typeof nodeSpawn = nodeSpawn) {}
  run(prompt: string, cwd: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const proc = this.spawnImpl('claude', ['-p', prompt], { cwd })
      let out = ''
      let err = ''
      proc.stdout?.on('data', (d: Buffer) => (out += d.toString()))
      proc.stderr?.on('data', (d: Buffer) => (err += d.toString()))
      proc.on('error', reject)
      proc.on('close', (code: number) => {
        if (code === 0) resolve(out.trim())
        else reject(new Error(`claude -p exited ${code}: ${err.trim()}`))
      })
    })
  }
}
