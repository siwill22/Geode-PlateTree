import { PROJECTION_LABEL, nextProjection, type ProjectionMode } from './projection';

/**
 * The single round button that cycles Projection, shared by the wrappers whose
 * Projection control lives in the page chrome rather than in lil-gui (climate,
 * Valdes). Paleobio uses a lil-gui dropdown instead; both walk the same
 * `PROJECTION_ORDER`, so they can never disagree about what follows what.
 *
 * It was a two-state toggle in each wrapper, written out twice with identical
 * icons and an `=== 'plateCarree'` test standing in for "not globe". Two states
 * is not extensible: a third Projection is unreachable through a control that
 * flips between two, which is why Robinson shipped visible only in paleobio.
 * Hence a cycle, and hence here rather than copied a third time.
 */

// Small inline sketches (graticule only -- no landmass shapes, since a stylised
// continent reads as a claim about geography these icons aren't making), not
// plain geometric glyphs either (a bare circle/rectangle character reads as
// unrelated to "map projection").
const ICON_GLOBE = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
  <circle cx="12" cy="12" r="9"/>
  <ellipse cx="12" cy="12" rx="4" ry="9"/>
  <path d="M3 12h18"/>
  <path d="M4.5 7.5c4 2 10.5 2 14.5 0"/>
  <path d="M4.5 16.5c4-2 10.5-2 14.5 0"/>
</svg>`.trim();

// Robinson: straight horizontal parallels, curved meridians, and a boundary
// that bulges at the equator and shortens (but does not converge to a point) at
// the poles -- the three things that distinguish it at a glance from both the
// globe and the rectangle beside it.
const ICON_ROBINSON = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
  <path d="M6.5 6.5h11c2 1.8 3 3.7 3 5.5s-1 3.7-3 5.5h-11c-2-1.8-3-3.7-3-5.5s1-3.7 3-5.5z"/>
  <path d="M4.3 9.6h15.4"/>
  <path d="M4.3 14.4h15.4"/>
  <path d="M12 6.5v11"/>
  <path d="M8.2 6.5c-.85 3.6-.85 7.4 0 11"/>
  <path d="M15.8 6.5c.85 3.6.85 7.4 0 11"/>
</svg>`.trim();

const ICON_PLATE_CARREE = `
<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">
  <rect x="3" y="6" width="18" height="12" rx="1.5"/>
  <path d="M3 10h18"/>
  <path d="M3 14h18"/>
  <path d="M9 6v12"/>
  <path d="M15 6v12"/>
</svg>`.trim();

const PROJECTION_ICON: Record<ProjectionMode, string> = {
  globe: ICON_GLOBE,
  robinson: ICON_ROBINSON,
  plateCarree: ICON_PLATE_CARREE,
};

/**
 * Wire `el` to cycle Projection, and paint it immediately.
 *
 * `current` is read rather than captured because the caller owns the mode and
 * may change it by other means (a test hook, a synced sibling instance); the
 * returned function repaints from whatever `current()` says now, and callers
 * that change Projection without clicking should call it.
 *
 * The icon shows what clicking switches TO, not the current shape -- an
 * established convention here, and one that extends to a cycle unchanged: it is
 * simply the NEXT entry rather than "the other one".
 */
export function wireProjectionToggle(
  el: HTMLElement | null,
  current: () => ProjectionMode,
  apply: (mode: ProjectionMode) => void,
): () => void {
  function refresh(): void {
    if (!el) return;
    const next = nextProjection(current());
    el.innerHTML = PROJECTION_ICON[next];
    const label = `Switch to ${PROJECTION_LABEL[next]} projection`;
    el.setAttribute('aria-label', label);
    el.setAttribute('title', label);
  }

  el?.addEventListener('click', () => {
    apply(nextProjection(current()));
    refresh();
  });

  // The page's static markup only carries a placeholder glyph so the button
  // isn't empty before this module runs.
  refresh();
  return refresh;
}
