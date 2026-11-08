// Backend activation is mutable: serialize it, rather than just hiding stale UI responses.
export class PageNavigation {
  private next: string | null = null;
  private active: Promise<void> | null = null;
  get running() { return this.active !== null; }
  request(id: string, run: (id: string, current: () => boolean) => Promise<void>): Promise<void> {
    this.next = id;
    if (!this.active) this.active = this.drain(run).finally(() => { this.active = null; this.next = null; });
    return this.active;
  }
  private async drain(run: (id: string, current: () => boolean) => Promise<void>) {
    while (this.next !== null) {
      const id = this.next; this.next = null;
      await run(id, () => this.next === null);
    }
  }
}
