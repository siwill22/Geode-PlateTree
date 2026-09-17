import { tileGrid, type Rect } from './layout';

/** What the host needs from a wrapper's own Instance class -- deliberately
 *  minimal, so `GlobeInstance`/`ClimateInstance`/etc. only have to grow
 *  exactly these two members to become host-managable, not adopt a whole
 *  base class. `applyLayout`/`dispose` already exist on every Instance
 *  class in the codebase (see docs/adr/0022) -- this interface just names
 *  the subset the host actually calls. */
export interface HostedInstance {
  applyLayout(rect: Rect): void;
  dispose(): void;
}

/**
 * Generic "N tiled instances sharing one canvas/camera" orchestration --
 * extracted from what `tomography/main.ts` and `climate/main.ts` each used
 * to hand-roll independently (see docs/adr/0022). Handles instance
 * bookkeeping, `core/layout.ts`'s tileGrid() relayout, focus tracking, and
 * a generic Synced Field broadcast registry (see CONTEXT.md's Synced
 * Field). Everything specific to one wrapper type -- how to boot a new
 * instance, which fields are actually syncable, what a click should focus
 * -- stays in that wrapper's own main.ts; the host only owns the parts that
 * were byte-for-byte identical across the two hand-built viewers.
 */
export class MultiInstanceHost<T extends HostedInstance> {
  readonly instances: T[] = [];
  layoutRects: Rect[] = [];
  focused: T | null = null;

  /** Per Synced Field name: whether it currently broadcasts. */
  private syncFlags = new Map<string, boolean>();
  /** Per Synced Field name: whichever instance most recently had that field
   *  edited -- the broadcast fallback source when a sync toggle turns on
   *  with no prior edit yet. Separate from `focused` on purpose: a user
   *  configuring a field typically does it entirely through that
   *  instance's own panel, without ever clicking its canvas tile (see
   *  tomography/main.ts's original lastAgeEdit for the identical
   *  reasoning this generalizes). */
  private lastEdit = new Map<string, T>();

  constructor(private readonly getViewport: () => { width: number; height: number }) {}

  /** Recompute the tile grid and move every instance onto its own rect --
   *  call after the instance count changes or the window resizes. */
  relayout(): void {
    const { width, height } = this.getViewport();
    this.layoutRects = tileGrid(this.instances.length, width, height);
    this.instances.forEach((inst, i) => inst.applyLayout(this.layoutRects[i]));
  }

  /** Register a newly created instance, relayout, and focus it if it's the
   *  first. Does not boot it -- booting is async and wrapper-specific, so
   *  the caller does that itself before or after calling this. */
  add(inst: T): void {
    this.instances.push(inst);
    if (!this.focused) this.focused = inst;
    this.relayout();
  }

  /** Remove an instance, always leaving at least one on screen. Returns
   *  whether it was actually removed. */
  remove(inst: T): boolean {
    if (this.instances.length <= 1) return false;
    const idx = this.instances.indexOf(inst);
    if (idx < 0) return false;
    this.instances.splice(idx, 1);
    inst.dispose();
    if (this.focused === inst) this.focused = this.instances[0];
    for (const [field, edited] of this.lastEdit) {
      if (edited === inst) this.lastEdit.delete(field);
    }
    this.relayout();
    return true;
  }

  setSync(field: string, on: boolean): void {
    this.syncFlags.set(field, on);
  }

  isSynced(field: string): boolean {
    return this.syncFlags.get(field) ?? false;
  }

  /** Whichever instance should be the broadcast source if a sync toggle for
   *  `field` turns on right now with no live edit driving it -- the most
   *  recent editor of that field, falling back to whatever's focused. */
  lastEditOrFocused(field: string): T | null {
    return this.lastEdit.get(field) ?? this.focused;
  }

  /** Push `source`'s current value of `field` to every OTHER instance via
   *  `apply`, and record `source` as that field's sync reference
   *  regardless of whether the field is currently synced -- the same
   *  "always record, only sometimes broadcast" rule the original
   *  broadcastAge/broadcastDepthSlice/broadcastMonth functions each
   *  implemented by hand. */
  broadcast<V>(field: string, source: T, value: V, apply: (inst: T, value: V) => void): void {
    this.lastEdit.set(field, source);
    if (!this.isSynced(field)) return;
    for (const inst of this.instances) {
      if (inst === source) continue;
      apply(inst, value);
    }
  }
}
