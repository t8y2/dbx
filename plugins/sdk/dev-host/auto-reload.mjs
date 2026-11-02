// Coalesce edits, serialize builds, and remember edits made during a build.
export class AutoReload {
  enabled = false;
  running = false;
  pending = false;
  timer;
  constructor(action, delay = 500) {
    this.action = action;
    this.delay = delay;
  }
  enable(value) {
    this.enabled = value;
    if (!value) {
      clearTimeout(this.timer);
      this.pending = false;
    }
  }
  changed() {
    if (!this.enabled) return;
    this.pending = true;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.flush(), this.delay);
  }
  async flush() {
    if (!this.enabled || !this.pending || this.running) return;
    this.pending = false;
    this.running = true;
    try {
      await this.action();
    } finally {
      this.running = false;
      if (this.pending && this.enabled) this.changed();
    }
  }
}
