import { findReferencePlateMatches, type PlateNameTable } from './plateNames';

// One shared counter across every instance on the page (Multi-Globe, or two
// different wrapper pages' panels side by side in a future combined view) --
// a shared <datalist> id would make every instance's autocomplete list the
// same DOM node.
let referencePlateControlCount = 0;

export interface ReferencePlateControlCallbacks {
  /** A plate id was resolved (typed, selected from the dropdown, or an
   *  empty/zero input) and should actually be applied. */
  onCommit(plateId: number): void;
}

/**
 * Native text input + `<datalist>` autocomplete for Reference Plate --
 * lil-gui has no autocomplete widget, so this bypasses it entirely (the same
 * "native input for a control lil-gui can't express" precedent as an age
 * slider). Shared by every wrapper's panel rather than reimplemented per
 * wrapper: see CONTEXT.md's Reference Plate entry and docs/adr/0030/0031 for
 * the design, and docs/plans/reference-plate.md for this control's own bug
 * history (a dropdown selection silently failing to commit, the row's
 * layout falling back to plain block stacking, 0 being undiscoverable once
 * another plate was set) -- all fixed here once so every wrapper gets them
 * for free instead of re-discovering them independently.
 */
export class ReferencePlateControl {
  readonly input: HTMLInputElement;
  private readonly row: HTMLDivElement;
  private readonly datalist: HTMLDataListElement;
  /** Plate ids with a rotation series in the currently-loaded Reconstruction
   *  Model -- set via setAvailable(), called once a rotation table is known.
   *  Empty (and the control disabled) whenever none is loaded at all -- see
   *  CONTEXT.md's Reference Plate entry. */
  private availablePlateIds: ReadonlySet<number> = new Set();
  /** This Reconstruction Model's plate id -> name lookup -- see
   *  core/plateNames.ts's own doc comment. Empty for a model with no name
   *  data at all (e.g. Scotese), in which case the autocomplete only ever
   *  matches by numeric id -- never a guessed name. */
  private plateNames: PlateNameTable = {};
  /** The last successfully committed id -- what an invalid edit reverts
   *  to, and where referencePlateLabel() starts from. Owned here, not by
   *  the caller: nothing outside user interaction with this control
   *  currently changes which plate is active (see this class's own commit
   *  path), so there is no external state to stay in sync with. */
  private currentId = 0;

  /** `anchor`'s row is where this control's own row is inserted immediately
   *  after -- typically the query-mode/tool dropdown right above it in the
   *  panel, so Reference Plate reads as part of the same "how am I viewing
   *  this" group. */
  constructor(anchor: HTMLElement, private cb: ReferencePlateControlCallbacks) {
    const row = document.createElement('div');
    // lil-gui's own controller classes, NOT a made-up "controller"/"name"/
    // "widget" -- lil-gui prefixes all of its CSS with "lil-" (see its own
    // Controller constructor), so anything else silently matches no rule at
    // all and falls back to plain block layout (label stacked above the
    // widget instead of beside it).
    row.className = 'lil-controller lil-string';
    const label = document.createElement('div');
    label.className = 'lil-name';
    label.textContent = 'reference plate';
    const widget = document.createElement('div');
    widget.className = 'lil-widget';

    const listId = `geode-reference-plate-${referencePlateControlCount++}`;
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('list', listId);
    input.placeholder = '0 (default)';
    input.disabled = true;
    Object.assign(input.style, { width: '100%', boxSizing: 'border-box' });

    const datalist = document.createElement('datalist');
    datalist.id = listId;

    widget.append(input, datalist);
    row.append(label, widget);
    anchor.insertAdjacentElement('afterend', row);

    input.addEventListener('input', () => this.refreshOptions(input.value));
    input.addEventListener('change', () => this.commit());
    // Select the existing text so typing immediately replaces it (the
    // standard combobox convention) instead of requiring a manual delete
    // first, and refresh the dropdown for an EMPTY query -- not whatever
    // decorated "Name (id)" label is currently displayed, which matches
    // nothing (see refreshOptions()'s own doc comment) and would hide the
    // "0 (default)" entry the moment something else is set.
    input.addEventListener('focus', () => {
      input.select();
      this.refreshOptions('');
    });

    this.input = input;
    this.row = row;
    this.datalist = datalist;
  }

  /** Candidates matching whatever's typed so far -- see
   *  core/plateNames.ts's findReferencePlateMatches(). Rebuilt on every
   *  keystroke. `option.value` is the BARE numeric id, not "Name (id)" --
   *  selecting a suggestion (click or keyboard) sets the input's value to
   *  `option.value` alone, so a selection always lands on commit()'s
   *  already-correct numeric branch. Putting the id+name combo in
   *  `option.value` instead was tried first and was broken: selecting it
   *  re-fired the 'input' handler with that full "Name (id)" string as the
   *  next query, which matches nothing (names don't contain the "(id)"
   *  suffix), silently discarding the selection -- see the postmortem in
   *  docs/plans/reference-plate.md. `option.label` is the friendly display
   *  text (id alongside name, so a wrong name-table mapping is visible at
   *  selection time, not just after committing). */
  private refreshOptions(query: string): void {
    const matches = findReferencePlateMatches(query, this.availablePlateIds, this.plateNames);
    this.datalist.replaceChildren(
      ...matches.map((m) => {
        const opt = document.createElement('option');
        opt.value = String(m.plateId);
        opt.label = `${m.name} (${m.plateId})`;
        return opt;
      }),
    );
  }

  /** Resolve the input's current text to a plate id and, if valid, report
   *  it -- accepts a bare numeric id (checked against `availablePlateIds`,
   *  see docs/adr/0030's plate-coverage rule; this is also what a dropdown
   *  selection resolves to, see refreshOptions()'s own doc comment), a
   *  typed-out exact name, or an empty string (0, the default/no-op).
   *  Anything else reverts the input to the last-known-good label rather
   *  than silently accepting an unresolvable plate. 0 is always accepted
   *  regardless of `availablePlateIds` -- see
   *  findReferencePlateMatches()'s own doc comment for why it can't be
   *  assumed to be a literal member of that set. */
  private commit(): void {
    const raw = this.input.value.trim();
    let id: number | null = null;
    if (raw === '' || raw === '0') {
      id = 0;
    } else if (/^\d+$/.test(raw) && this.availablePlateIds.has(Number(raw))) {
      id = Number(raw);
    } else {
      // Typed a name out by hand rather than selecting a suggestion. Only
      // accepts an UNAMBIGUOUS exact name match (case-insensitive) -- a
      // partial/ambiguous typed string with no dropdown selection is not
      // guessed at.
      const exact = findReferencePlateMatches(raw, this.availablePlateIds, this.plateNames)
        .filter((m) => m.name.toLowerCase() === raw.toLowerCase());
      if (exact.length === 1) id = exact[0].plateId;
    }

    if (id === null) {
      this.input.value = this.label(this.currentId);
      return;
    }
    this.currentId = id;
    this.input.value = id === 0 ? '' : this.label(id);
    this.cb.onCommit(id);
  }

  /** Includes the bare id alongside the name (e.g. "Antarctica (802)") --
   *  deliberately, not just cosmetic: even a generated, per-model name
   *  table (see core/plateNames.ts's own doc comment) could still be wrong
   *  in a way nobody's checked yet, so showing the id a selection actually
   *  resolved to makes that visible/reportable instead of silently
   *  trusted. Falls back to a bare "Plate N" for a model with no name data
   *  at all (e.g. Scotese) -- never a guessed name. */
  private label(id: number): string {
    const match = findReferencePlateMatches(String(id), new Set([id]), this.plateNames)[0];
    return match ? `${match.name} (${id})` : `Plate ${id}`;
  }

  /** Reflect an externally-driven plate id (e.g. Multi-Globe sync applying
   *  the broadcast source's value to a follower) without re-firing
   *  onCommit -- the caller already applied the id itself; this only
   *  updates what the control displays. */
  setValue(id: number): void {
    this.currentId = id;
    this.input.value = id === 0 ? '' : this.label(id);
  }

  /** Which plate ids the currently-loaded Reconstruction Model actually has
   *  a rotation series for, and its plate-name lookup (empty for a model
   *  with no name data at all, e.g. Scotese). An empty `ids` disables the
   *  control entirely (see CONTEXT.md's Reference Plate entry: "no
   *  rotation table loaded" -> disabled); an empty `names` just means the
   *  autocomplete only ever matches by numeric id, never a guessed name. */
  setAvailable(ids: ReadonlySet<number>, names: PlateNameTable): void {
    this.availablePlateIds = ids;
    this.plateNames = names;
    this.input.disabled = ids.size === 0;
    this.input.placeholder = Object.keys(names).length === 0
      ? '0 (default) -- plate id only, no names for this model'
      : '0 (default)';
    this.input.title = ids.size === 0
      ? 'unavailable -- this model has no rotation data loaded'
      : '';
  }

  dispose(): void {
    this.row.remove();
  }
}
