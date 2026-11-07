// A bridge connection alone does not enable capture; at least one dashboard must be open.
export class VisionMonitorPresence {
  constructor(onChange) {
    this.clients = new Map();
    this.active = false;
    this.onChange = onChange;
  }

  add(socket) {
    this.clients.set(socket, false);
  }

  update(socket, active) {
    if (!this.clients.has(socket) || typeof active !== 'boolean') return;
    this.clients.set(socket, active);
    this.refresh();
  }

  remove(socket) {
    this.clients.delete(socket);
    this.refresh();
  }

  refresh() {
    const active = [...this.clients.values()].some(Boolean);
    if (this.active === active) return;
    this.active = active;
    this.onChange(active);
  }
}
