/** The fixed v1 UI-tool menu a recipe's `ui.tools` can draw from -- see
 *  generator/validateRecipe.mjs's TOOL_ALLOWLIST (kept in sync by
 *  inspection; that script runs standalone under plain Node and can't
 *  import this file directly -- see its own doc comment on
 *  resolveCoastlines() for why). Shared by every wrapper type
 *  (`globe/`, `groupGlobe/`, ...) so none of them depend on each other --
 *  a generated repo only ever copies the one wrapper directory its recipe
 *  needs, plus `core/`.
 *
 *  `time-series` is only meaningful for `single-model-globe`/
 *  `model-group-globe` (see docs/adr/0023) -- the two reconstruction
 *  wrapper types never see `ui.tools` at all (their recipe fields are
 *  `reconstructionIds`, not `datasets`/`ui`), so there's nothing to reject
 *  there; validateRecipe.mjs instead rejects a Model with no variable a
 *  Field Aggregate series can be computed for. */
export type GlobeTool = 'legend' | 'age-slider' | 'no-data-toggle' | 'query-point' | 'time-series';

/** A recipe's opt-in Multi-Globe setting (see CONTEXT.md's Multi-Globe /
 *  Synced Field entries, docs/adr/0022) -- kept separate from `GlobeTool`
 *  since it changes how many instances exist rather than toggling
 *  something on one instance's own panel. `syncAge` is the only Synced
 *  Field a generated site exposes today: depth-slice and month aren't in
 *  the fixed GlobeTool vocabulary at all, so there's nothing else to
 *  broadcast yet. Present (any value) means the recipe asked for the
 *  "+ Add globe" toolbar; absent means a single, fixed instance, matching
 *  every generated site's behaviour before this existed. */
export interface MultiGlobeConfig {
  syncAge: boolean;
}
