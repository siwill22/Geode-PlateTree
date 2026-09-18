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
  /** Which longitude sits at the middle of a flat map. Not a panel control:
   *  it is dragged on the map itself, and shown in the status text. */
  centreLon: number;
  showLocked: boolean;
  showLabels: boolean;
  colorByGroup: boolean;
  showCoastlines: boolean;
  showPlates: boolean;
  /** The resolved plate-boundary backdrop (ridges/subduction/transform),
   *  drawn muted -- context for the tree, not this viewer's own subject. */
  showTopology: boolean;
}

export interface PlateTreeUiHooks {
  onAge(age: number): void;
  onProjection(mode: ProjectionMode): void;
  onTheme(id: ThemeId): void;
  onTreeSource(s: TreeSource): void;
  onShowLocked(v: boolean): void;
  onShowLabels(v: boolean): void;
  onColorByGroup(v: boolean): void;
  onShowCoastlines(v: boolean): void;
  onShowPlates(v: boolean): void;
  onShowTopology(v: boolean): void;
  onClearSelection(): void;
}

/** The sans-serif stack the rest of the Geode viewer family uses for its UI
 *  chrome (see e.g. reconstruction.html, deep-time-map's explorer.css).
 *  Plate Tree's fixed status/circuit/info text previously used a monospace
 *  stack of its own, which read as a different application. */
const UI_FONT = 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif';

/**
 * Chrome follows a Theme's LIGHTNESS only, the same rule core/theme.ts states
 * for every other Geode viewer's panels -- never the Theme's own roles, which
 * would tie this fixed UI to the data palette it sits over. Plate Tree's own
 * panels used one hardcoded dark look regardless of Theme until this was
 * added: harmless on a dark Theme, but on Frost or Parchment it put pale grey
 * text on a dark box that itself sat on a near-white globe -- legible on
 * neither the box nor the colour choice.
 */
const DARK_CHROME = {
  bg: 'rgba(12,16,22,0.82)', border: '1px solid rgba(255,255,255,0.10)',
  ink: 'rgba(235,240,250,0.92)', inkDim: 'rgba(235,240,250,0.62)',
  shadow: '0 1px 3px rgba(0,0,0,0.85)',
  overlayBg: 'rgba(255,255,255,0.08)', overlayBorder: '1px solid rgba(255,255,255,0.18)',
};
const LIGHT_CHROME = {
  bg: 'rgba(255,255,255,0.88)', border: '1px solid rgba(20,24,32,0.14)',
  ink: 'rgba(20,24,32,0.92)', inkDim: 'rgba(20,24,32,0.62)',
  shadow: '0 1px 3px rgba(255,255,255,0.9)',
  overlayBg: 'rgba(20,24,32,0.06)', overlayBorder: '1px solid rgba(20,24,32,0.16)',
};
let chrome = DARK_CHROME;

/** One-time stylesheet for the native range input -- browsers have no usable
 *  default look for a slider thumb/track against a dark UI, and pseudo-
 *  elements (::-webkit-slider-thumb etc.) cannot be reached from inline
 *  styles at all, so this is the one thing that has to be a stylesheet
 *  rather than Object.assign(el.style, ...) like everything else here. */
function ensureTimebarStyles(): void {
  if (document.getElementById('pt-timebar-style')) return;
  const style = document.createElement('style');
  style.id = 'pt-timebar-style';
  style.textContent = `
    .pt-scrub { -webkit-appearance: none; appearance: none; flex: 1; height: 16px;
      background: transparent; cursor: pointer; }
    .pt-scrub::-webkit-slider-runnable-track { height: 3px; border-radius: 2px;
      background: rgba(255,255,255,0.2); }
    .pt-scrub::-moz-range-track { height: 3px; border-radius: 2px;
      background: rgba(255,255,255,0.2); }
    .pt-scrub::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
      width: 15px; height: 15px; margin-top: -6px; border: none; border-radius: 50%;
      background: #6fe3ff; box-shadow: 0 0 0 3px rgba(111,227,255,0.22); }
    .pt-scrub::-moz-range-thumb { width: 15px; height: 15px; border: none;
      border-radius: 50%; background: #6fe3ff; box-shadow: 0 0 0 3px rgba(111,227,255,0.22); }
  `;
  document.head.appendChild(style);
}

export class PlateTreeUi {
  private gui: GUI;
  private status: HTMLDivElement;
  private circuit: HTMLDivElement;
  private timebar: HTMLDivElement;
  private ageSlider: HTMLInputElement;
  private ageLabel: HTMLSpanElement;
  private infoButton: HTMLButtonElement;
  private infoPanel: HTMLDivElement;
  private ageName: HTMLSpanElement;
  private sourceController: ReturnType<GUI['add']>;
  private topologyController: ReturnType<GUI['add']>;

  constructor(
    private view: PlateTreeViewState,
    private hooks: PlateTreeUiHooks,
    title: string,
  ) {
    this.gui = new GUI({ title });

    this.gui
      .add(this.view, 'projection', [...PROJECTION_ORDER])
      .name('projection')
      // lil-gui has already written the new value into `view` by the time this
      // fires, so never guard on view.projection here -- guard downstream, on a
      // field lil-gui does not own.
      .onChange((v: ProjectionMode) => this.hooks.onProjection(v));

    // No centre-longitude control here on purpose: on a flat map it is dragged
    // directly, which is how every other map behaves, and a slider alongside it
    // would be a second way to do the same thing.

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
    this.topologyController = tree.add(this.view, 'showTopology').name('plate boundaries')
      .onChange((v: boolean) => this.hooks.onShowTopology(v));

    this.status = document.createElement('div');
    this.status.id = 'status';
    Object.assign(this.status.style, {
      position: 'fixed', left: '12px', top: '12px', zIndex: '10',
      font: `12px/1.5 ${UI_FONT}`,
      color: chrome.ink, textShadow: chrome.shadow,
      pointerEvents: 'none', whiteSpace: 'pre',
    });
    document.body.appendChild(this.status);

    this.circuit = document.createElement('div');
    this.circuit.id = 'circuit';
    Object.assign(this.circuit.style, {
      position: 'fixed', left: '12px', bottom: '92px', zIndex: '10',
      maxWidth: 'min(560px, 46vw)', padding: '10px 12px',
      background: chrome.bg, borderRadius: '6px', border: chrome.border,
      font: `12px/1.6 ${UI_FONT}`,
      color: chrome.ink, display: 'none',
    });
    document.body.appendChild(this.circuit);

    ({
      bar: this.timebar, slider: this.ageSlider, label: this.ageLabel, name: this.ageName,
    } = this.buildTimebar());
    ({ button: this.infoButton, panel: this.infoPanel } = this.buildInfo());
  }

  /**
   * Re-skin every fixed panel for a Theme's lightness. Chrome follows
   * lightness only, never a Theme's roles (see the DARK_CHROME/LIGHT_CHROME
   * comment above) -- call this from the same place `applyChromeLightness()`
   * is called, so the two stay in step.
   */
  applyLightness(lightness: 'light' | 'dark'): void {
    chrome = lightness === 'light' ? LIGHT_CHROME : DARK_CHROME;

    Object.assign(this.status.style, { color: chrome.ink, textShadow: chrome.shadow });

    for (const el of [this.circuit, this.timebar, this.infoButton, this.infoPanel]) {
      Object.assign(el.style, { background: chrome.bg, border: chrome.border, color: chrome.ink });
    }
    Object.assign(this.ageName.style, { color: chrome.inkDim });
    Object.assign(this.ageLabel.style, { color: chrome.inkDim });

    // The legend's own dim text and heading colours were baked into the HTML
    // string at build time; simplest to just rebuild it rather than track a
    // second parallel set of element references for six spans of text.
    this.infoPanel.innerHTML = this.infoHtml();
  }

  // -- time bar -------------------------------------------------------------

  /** A wide, bottom, fixed time bar -- the arrangement every other Geode
   *  viewer uses (see deep-time-map's explorer.css `.dtm-timebar`) -- rather
   *  than a slider buried in the narrow lil-gui column, so the control that
   *  matters most for exploring 1800 Myr of history gets the screen width to
   *  work with. */
  private buildTimebar(): {
    bar: HTMLDivElement; slider: HTMLInputElement; label: HTMLSpanElement; name: HTMLSpanElement;
  } {
    ensureTimebarStyles();

    const bar = document.createElement('div');
    bar.id = 'timebar';
    Object.assign(bar.style, {
      position: 'fixed', left: '1.5rem', right: '1.5rem', bottom: '1.2rem', zIndex: '10',
      display: 'flex', alignItems: 'center', gap: '0.9rem',
      padding: '0.7rem 1.1rem', borderRadius: '10px',
      background: chrome.bg, border: chrome.border,
      font: `13px/1.4 ${UI_FONT}`, color: chrome.ink,
    });

    const name = document.createElement('span');
    name.textContent = 'Age';
    Object.assign(name.style, { color: chrome.inkDim, flex: 'none' });

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.className = 'pt-scrub';
    slider.min = '0';
    slider.max = '1800';
    slider.step = '1';
    slider.value = String(this.view.age);
    slider.addEventListener('input', () => {
      const age = Number(slider.value);
      this.view.age = age;
      label.textContent = this.formatAge(age);
      this.hooks.onAge(age);
    });

    const label = document.createElement('span');
    label.textContent = this.formatAge(this.view.age);
    Object.assign(label.style, {
      flex: 'none', minWidth: '5.5em', textAlign: 'right',
      fontVariantNumeric: 'tabular-nums', color: chrome.inkDim,
    });

    bar.append(name, slider, label);
    document.body.appendChild(bar);
    return { bar, slider, label, name };
  }

  private formatAge(age: number): string {
    return `${age.toFixed(0)} Ma`;
  }

  setAgeRange(min: number, max: number): void {
    this.ageSlider.min = String(min);
    this.ageSlider.max = String(max);
  }

  // -- info / legend ----------------------------------------------------------

  /** The (i) button and its legend panel, explaining what a node's size/shape
   *  and colour mean and what the three link styles are -- none of which is
   *  otherwise written down anywhere on the page. Sits just above the time
   *  bar, bottom-right, so it can never collide with the status text
   *  (top-left), lil-gui (top-right) or the circuit readout (bottom-left). */
  private buildInfo(): { button: HTMLButtonElement; panel: HTMLDivElement } {
    const button = document.createElement('button');
    button.id = 'pt-info-button';
    button.textContent = 'i';
    button.setAttribute('aria-label', 'What am I looking at?');
    Object.assign(button.style, {
      position: 'fixed', right: '1.5rem', bottom: '5.1rem', zIndex: '10',
      width: '26px', height: '26px', padding: '0', borderRadius: '50%',
      border: chrome.border, background: chrome.bg, color: chrome.ink,
      font: `13px/1 ${UI_FONT}`, fontStyle: 'italic', fontWeight: '600',
      cursor: 'pointer',
    });

    const panel = document.createElement('div');
    panel.id = 'pt-info-panel';
    Object.assign(panel.style, {
      position: 'fixed', right: '1.5rem', bottom: '8.1rem', zIndex: '10',
      width: 'min(360px, 84vw)', maxHeight: '68vh', overflow: 'auto',
      padding: '14px 16px', borderRadius: '8px',
      background: chrome.bg, border: chrome.border,
      font: `12px/1.6 ${UI_FONT}`, color: chrome.ink, display: 'none',
    });
    panel.innerHTML = this.infoHtml();

    button.addEventListener('click', () => {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
    });

    document.body.append(button, panel);
    return { button, panel };
  }

  private infoHtml(): string {
    const row = (swatch: string, text: string) => (
      `<div style="display:flex;align-items:center;gap:8px;margin:4px 0;">`
      + `${swatch}<span>${text}</span></div>`
    );
    const dot = (fill: string, r = 6) => (
      `<svg width="16" height="16" viewBox="0 0 16 16" style="flex:none">`
      + `<circle cx="8" cy="8" r="${r}" fill="${fill}"/></svg>`
    );
    const star = (fill: string) => (
      `<svg width="16" height="16" viewBox="0 0 16 16" style="flex:none">`
      + `<path d="M8 1.5 9.4 5.9 14 5.9 10.3 8.6 11.7 13 8 10.3 4.3 13 5.7 8.6 2 5.9 6.6 5.9Z" `
      + `fill="${fill}"/></svg>`
    );
    const line = (stroke: string, dash = '') => (
      `<svg width="20" height="10" style="flex:none">`
      + `<line x1="0" y1="5" x2="20" y2="5" stroke="${stroke}" stroke-width="2.4" `
      + `stroke-dasharray="${dash}"/></svg>`
    );

    return (
      `<h3 style="margin:0 0 8px;font-size:12px;letter-spacing:.06em;`
      + `text-transform:uppercase;color:${chrome.inkDim}">Reading the plate tree</h3>`
      + `<p style="margin:0 0 10px;color:${chrome.inkDim}">Each node is a plate; each `
      + `link is the rotation one plate is defined relative to, all the way to `
      + `the anchor plate.</p>`
      + row(star('#ffd34d'), 'Root plate — closest to the anchor along its own path')
      + row(dot('#6fe3ff', 6), 'On the selected plate circuit')
      + row(dot('#cfd6e4', 4.5), 'An ordinary plate, coloured by locked group')
      + `<h3 style="margin:14px 0 8px;font-size:12px;letter-spacing:.06em;`
      + `text-transform:uppercase;color:${chrome.inkDim}">Links</h3>`
      + row(line('#e8663c'), 'Moving — the two plates rotate relative to each other')
      + row(line('rgba(160,170,185,0.7)'), 'Locked — no relative motion (a Locked Group)')
      + row(line('#e8663c', '5 4'), 'Patched — passes through a plate with no '
        + 'geometry at this age')
      + `<h3 style="margin:14px 0 8px;font-size:12px;letter-spacing:.06em;`
      + `text-transform:uppercase;color:${chrome.inkDim}">Backdrop</h3>`
      + row(line('rgba(232,102,60,0.4)'), 'Resolved plate-boundary topologies '
        + '(ridge / subduction / transform), shown muted — context, not the '
        + 'subject of this map')
    );
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
      background: chrome.overlayBg, color: 'inherit',
      border: chrome.overlayBorder, borderRadius: '4px',
      padding: '2px 8px',
    });
    close.onclick = () => this.hooks.onClearSelection();

    this.circuit.append(h, body, f, close);
    this.circuit.style.display = 'block';
  }

  hideCircuit(): void { this.circuit.style.display = 'none'; }

  refreshDisplay(): void {
    this.gui.controllersRecursive().forEach((c) => c.updateDisplay());
    this.ageSlider.value = String(this.view.age);
    this.ageLabel.textContent = this.formatAge(this.view.age);
  }

  projectionLabel(mode: ProjectionMode): string { return PROJECTION_LABEL[mode]; }

  /** A model with no dynamic polygons has no topological tree to offer, so the
   *  choice is removed rather than left to fail on selection. */
  setTopologicalAvailable(on: boolean): void {
    this.sourceController.enable(on);
  }

  /** A model with no dynamic polygons also has no resolved boundary topology
   *  to export -- see prep_boundaries.py, which shares that requirement. */
  setTopologyAvailable(on: boolean): void {
    this.topologyController.enable(on);
  }

  dispose(): void {
    this.gui.destroy();
    this.status.remove();
    this.circuit.remove();
    this.timebar.remove();
    this.infoButton.remove();
    this.infoPanel.remove();
  }
}
