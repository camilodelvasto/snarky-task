export class JobPool {
  private max: number
  private running = 0
  private waiting: Array<() => void> = []
  constructor(maxParallel: number) {
    this.max = maxParallel
  }
  get active(): number {
    return this.running
  }
  async run<T>(job: () => Promise<T>): Promise<T> {
    if (this.running >= this.max) await new Promise<void>((r) => this.waiting.push(r))
    this.running++
    try {
      return await job()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}
