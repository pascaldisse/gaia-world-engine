// Per-client undo/redo: every edit records its inverse ops at capture time.
// Coalesces rapid edits to the same target (slider drags) into one entry.
export class History {
  constructor(send) {
    this.send = send;
    this.undoStack = [];
    this.redoStack = [];
  }

  push(undoOps, redoOps, key = null) {
    const top = this.undoStack[this.undoStack.length - 1];
    if (key && top?.key === key && Date.now() - top.t < 1200) {
      top.redoOps = redoOps;
      top.t = Date.now();
      this.redoStack.length = 0;
      return;
    }
    this.undoStack.push({ undoOps, redoOps, key, t: Date.now() });
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo() {
    const entry = this.undoStack.pop();
    if (!entry) return;
    this.send(entry.undoOps);
    this.redoStack.push(entry);
  }

  redo() {
    const entry = this.redoStack.pop();
    if (!entry) return;
    this.send(entry.redoOps);
    this.undoStack.push(entry);
  }
}
