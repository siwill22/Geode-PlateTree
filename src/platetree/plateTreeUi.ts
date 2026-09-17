import GUI from 'lil-gui';

import { PROJECTION_LABEL, PROJECTION_ORDER, type ProjectionMode } from '../core/projection';
import { ALL_THEMES, type ThemeId } from '../core/theme';

/** Which polygons the Plate Tree is built from -- gprm's own `polygon_type`
 *  option. Not a rendering choice: the two trees have different plates, so
 *  they are different statements about the model. */
export type TreeSource = 'static' | 'topological';

export interface PlateTreeViewState {
  age: number;
  projection: ProjectionMode;
  theme: ThemeId;
  treeSource: TreeSource;
  /** Which longitude sits at the middle of a flat map. */
  centreLon: number;
  showLocked: boolean;
  showLabels: boolean;
  colorByGroup: boolean;
  showCoastlines: boolean;
  showPlates: boolean;
}

export interface PlateTreeUiHooks {
  onAge(age: number): void;
  onProjection(mode: ProjectionMode): void;
  onTheme(id: ThemeId): void;
  onTreeSource(s: TreeSource): void;
  onCentreLon(lon: number): void;
  onShowLocked(v: boolean): void;
  onShowLabels(v: boolean): void;
  onColorByGroup(v: boolean): void;
  onShowCoastlines(v: boolean): void;
  onShowPlates(v: boolean): void;
  onClearSelection(): void;
}

export class PlateTreeUi {
  private gui: GUI;
  private status: HTMLDivElement;
  private circuit: HTMLDivElement;
  private ageController: ReturnType<GUI['add']>;
  private centreController: ReturnType<GUI['add']>;
  private sourceController: ReturnType<GUI['add']>;

  constructor(
    private view: PlateTreeViewState,
    private hooks: PlateTreeUiHooks,
    title: string,
  ) {
    this.gui = new GUI({ title });

    this.ageController = this.gui
      .add(this.view, 'age', 0, 1800, 1)
      .name('age (Ma)')
      .onChange((v: number) => this.hooks.onAge(v));

    this.gui
      .add(this.view, 'projection', [...PROJECTION_ORDER])
      .name('projection')
      // lil-gui has already written the new value into `view` by the time this
      // fires, so never guard on view.projection here -- guard downstream, on a
      // field lil-gui does not own.
      .onChange((v: ProjectionMode) => this.hooks.onProjection(v));

    // Live only on a flat map -- the globe has free orbit, which is the same
    // control by other means. Kept in the panel rather than hidden so its
    // value is visible when a flat Projection is selected.
    this.centreController = this.gui
      .add(this.view, 'centreLon', -180, 180, 1)
      .name('centre lon')
      .onChange((v: number) => this.hooks.onCentreLon(v));

    this.gui
      .add(this.view, 'theme', ALL_THEMES.map((t) => t.id))
      .name('theme')
      .onChange((v: ThemeId) => this.hooks.onTheme(v));

    const tree = this.gui.addFolder('tree');
    this.sourceController = tree
      .add(this.view, 'treeSource', ['static', 'topological'])
      .name('built from')
      .onChange((v: TreeSource) => this.hooks.onTreeSource(v));
    tree.add(this.view, 'showPlates').name('plate mosaic')
      .onChange((v: boolean) => this.hooks.onShowPlates(v));
    tree.add(this.view, 'showLocked').name('locked links')
      .onChange((v: boolean) => this.hooks.onShowLocked(v));
    tree.add(this.view, 'colorByGroup').name('colour by group')
      .onChange((v: boolean) => this.hooks.onColorByGroup(v));
    tree.add(this.view, 'showLabels').name('all plate ids')
      .onChange((v: boolean) => this.hooks.onShowLabels(v));
    tree.add(this.view, 'showCoastlines').name('coastlines')
      .onChange((v: boolean) => this.hooks.onShowCoastlines(v));

    this.status = document.createElement('div');
    this.status.id = 'status';
    Object.assign(this.status.style, {
      position: 'fixed', left: '12px', top: '12px', zIndex: '10',
      font: '12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: 'rgba(235,240,250,0.92)', textShadow: '0 1px 3px rgba(0,0,0,0.85)',
      pointerEvents: 'none', whiteSpace: 'pre',
    });
    document.body.appendChild(this.status);

    this.circuit = document.createElement('div');
    this.circuit.id = 'circuit';
    Object.assign(this.circuit.style, {
      position: 'fixed', left: '12px', bottom: '12px', zIndex: '10',
      maxWidth: 'min(560px, 46vw)', padding: '10px 12px',
      background: 'rgba(12,16,22,0.82)', borderRadius: '6px',
      border: '1px solid rgba(255,255,255,0.10)',
      font: '12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace',
      color: 'rgba(235,240,250,0.92)', display: 'none',
    });
    document.body.appendChild(this.circuit);
  }

  setStatus(text: string): void { this.status.textContent = text; }

  /** Show one Plate Circuit. `patched` marks hops that are not adjacent in the
   *  hierarchy, so a reader is never told two plates are neighbours when the
   *  circuit actually runs through plates with no geometry at this age. */
  showCircuit(
    heading: string, steps: { label: string; patched: boolean }[],
    footnote: string,
  ): void {
    const parts = steps.map((s, i) => {
      const arrow = i === 0 ? '' : (s.patched ? ' ⇢ ' : ' → ');
      return `${arrow}${s.label}`;
    }).join('');
    this.circuit.innerHTML = '';

    const h = document.createElement('div');
    h.textContent = heading;
    Object.assign(h.style, { opacity: '0.72', marginBottom: '4px' });

    const body = document.createElement('div');
    body.textContent = parts;
    body.style.wordBreak = 'break-word';

    const f = document.createElement('div');
    f.textContent = footnote;
    Object.assign(f.style, { opacity: '0.62', marginTop: '6px', fontSize: '11px' });

    const close = document.createElement('button');
    close.textContent = 'clear';
    Object.assign(close.style, {
      marginTop: '8px', font: 'inherit', cursor: 'pointer',
      background: 'rgba(255,255,255,0.08)', color: 'inherit',
      border: '1px solid rgba(255,255,255,0.18)', borderRadius: '4px',
      padding: '2px 8px',
    });
    close.onclick = () => this.hooks.onClearSelection();

    this.circuit.append(h, body, f, close);
    this.circuit.style.display = 'block';
  }

  hideCircuit(): void { this.circuit.style.display = 'none'; }

  refreshDisplay(): void { this.gui.controllersRecursive().forEach((c) => c.updateDisplay()); }

  setAgeRange(min: number, max: number): void {
    this.ageController.min(min).max(max);
  }

  projectionLabel(mode: ProjectionMode): string { return PROJECTION_LABEL[mode]; }

  /** Grey the centre-longitude slider out on the globe, where it does nothing
   *  -- an orbiting camera already chooses what faces the viewer. */
  setCentreEnabled(on: boolean): void {
    this.centreController.enable(on);
  }

  /** A model with no dynamic polygons has no topological tree to offer, so the
   *  choice is removed rather than left to fail on selection. */
  setTopologicalAvailable(on: boolean): void {
    this.sourceController.enable(on);
  }

  dispose(): void {
    this.gui.destroy();
    this.status.remove();
    this.circuit.remove();
  }
}
