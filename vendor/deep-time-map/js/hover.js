/*
 * Hover and click-to-pin for a pickable layer.
 *
 * This is the only module in the library that touches the DOM, and it is deliberately NOT
 * re-exported from index.js: a consumer rendering to a canvas in a worker, or testing
 * layers headlessly, should never have to load it.
 *
 * What it does is small but fiddly, and every consumer would otherwise rewrite it:
 *
 *   - Throttles pointermove to one pick per animation frame. Pointer events fire far
 *     faster than the display refreshes, and picking more often than you draw is wasted.
 *   - Suppresses hover while the globe is being dragged, and does not let the pointerup
 *     ending a drag register as a click.
 *   - Flips the popup around the pointer near the viewport edge, so it never runs off.
 *   - Keeps the popup click-through until it is pinned, because a popup that accepts
 *     pointer events while merely hovering steals the hover from the canvas underneath
 *     and flickers between shown and hidden.
 *
 * Content is entirely the caller's business: `format(point)` returns HTML.
 */

const DEFAULTS = {
  // Below this much pointer travel, a press-and-release is a click rather than a drag.
  // Without it, letting go of a globe drag over a symbol pins a popup you did not ask for.
  dragThreshold: 4,
  offset: 14,
  margin: 8,
  pinnedClass: 'is-pinned',
  visibleClass: 'is-visible',

  /*
   * Spiderfy timing. The layer decides WHAT fans apart; this decides WHEN.
   *
   * A dwell rather than an instant trigger, because on a dense map most pointer positions
   * are near some cluster -- firing immediately would make the map churn apart and back
   * together continuously as the pointer swept across it. Resting briefly is the signal
   * that you actually want to look at something.
   */
  spiderfy: true,
  spiderfyDwell: 150,        // ms of stillness before a cluster opens

  // Hysteresis: once open, the fan survives until the pointer leaves a radius comfortably
  // larger than the fan itself. Collapsing at the same boundary that opened it would make
  // the fan flicker whenever the pointer sat near the edge.
  spiderfyKeepPadding: 26,
};

/**
 * @param element    the element pointer events are listened on (the stage)
 * @param popup      an absolutely-positioned element to fill and place
 * @param layer      anything with pick(x, y) and highlight(index)
 * @param projector  unused directly; kept so callers can pass one object around
 * @param render     called when the highlight changes and the canvas needs redrawing
 * @param format     (point, index) => HTML string for the popup body
 * @returns { destroy, clear, pinned }
 */
export function attachHover({
  element, popup, layer, render, format, ...rest
}) {
  const opts = { ...DEFAULTS, ...rest };

  let pinned = false;
  let frame = null;
  let pending = null;
  let downAt = null;
  let travelled = 0;
  let shownIndex = -1;

  let dwellTimer = null;
  let fanAnchor = null;      // canvas position the open fan is centred on
  let fanReach = 0;          // how far the pointer may stray before it collapses
  let ticker = null;

  const rectOf = () => element.getBoundingClientRect();

  /* ---- spiderfy ---------------------------------------------------------- */

  /** Keep rendering while the fan is still moving; the page renders on events otherwise. */
  function runTicker() {
    if (ticker !== null) return;
    const step = () => {
      if (layer.isAnimating?.()) {
        render();
        ticker = requestAnimationFrame(step);
      } else {
        ticker = null;
        render();            // one last frame so it settles exactly on its final position
      }
    };
    ticker = requestAnimationFrame(step);
  }

  function openFan(x, y) {
    const n = layer.spiderfy?.(x, y) || 0;
    if (!n) return false;

    // Size the keep-alive radius to the fan itself, so a 25-member spiral gets the room it
    // needs rather than a fixed guess tuned for a 3-member ring.
    fanAnchor = [x, y];
    fanReach = (layer.spiderExtent?.() || 0) + opts.spiderfyKeepPadding;
    runTicker();
    render();
    return true;
  }

  function closeFan() {
    cancelDwell();
    fanAnchor = null;
    if (layer.unspiderfy?.()) {
      render();
      return true;
    }
    return false;
  }

  function cancelDwell() {
    if (dwellTimer !== null) { clearTimeout(dwellTimer); dwellTimer = null; }
  }

  /**
   * Decide what the open fan should do about this pointer position, and arm the dwell for
   * a new one.
   *
   * @param hit  what pick() returned here, so a fan can tell whether the pointer has moved
   *             onto one of its own members or onto something else entirely.
   */
  function considerFan(x, y, hit) {
    if (!opts.spiderfy || !layer.spiderfy) return;

    if (fanAnchor) {
      // A pinned popup describes a fanned member; yanking the fan out from under the
      // reader would be hostile.
      if (pinned) return;

      const members = layer.spiderfied;
      const onMember = hit && members && members.indexOf(hit.index) >= 0;

      // Working inside the fan: stay open. This is the whole reason for the keep radius --
      // moving between members must not collapse it.
      if (onMember) return;

      const strayed = Math.hypot(x - fanAnchor[0], y - fanAnchor[1]) > fanReach;

      // Inside the keep radius but over nothing in particular -- still hovering the fan's
      // own space, so leave it alone.
      if (!strayed && !hit) return;

      // Either the pointer wandered off, or it is now over a point this fan does not own.
      // The second case is the one that matters: the keep radius is generous enough to
      // cover neighbouring deposits, so without this the old fan would sit there expanded
      // while the pointer hovered something else entirely.
      closeFan();
      // Fall through, so the point now under the pointer can arm its own fan immediately
      // rather than waiting for the next pointer move.
    }

    cancelDwell();
    // Only arm where there is actually a pile. Asking the layer first avoids a timer per
    // pointer move across empty ocean.
    if ((layer.clusterSizeAt?.(x, y) || 0) < 2) return;
    dwellTimer = setTimeout(() => {
      dwellTimer = null;
      openFan(x, y);
    }, opts.spiderfyDwell);
  }

  function show(hit) {
    if (hit.index !== shownIndex) {
      popup.innerHTML = format(hit.point, hit.index);
      shownIndex = hit.index;
    }
    popup.classList.add(opts.visibleClass);
    place(hit.x, hit.y);
  }

  function place(x, y) {
    const rect = rectOf();
    const w = popup.offsetWidth;
    const h = popup.offsetHeight;
    const { offset, margin } = opts;

    // Prefer down-right of the symbol, flip when that would overflow the container.
    let left = x + offset;
    if (left + w > rect.width - margin) left = x - offset - w;
    left = Math.max(margin, Math.min(rect.width - w - margin, left));

    let top = y + offset;
    if (top + h > rect.height - margin) top = y - offset - h;
    top = Math.max(margin, Math.min(rect.height - h - margin, top));

    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
  }

  function hide() {
    popup.classList.remove(opts.visibleClass);
    shownIndex = -1;
  }

  function clear() {
    pinned = false;
    popup.classList.remove(opts.pinnedClass);
    hide();
    closeFan();
    if (layer.highlight(null)) render();
  }

  /** One pick per frame, whatever the pointer rate. */
  function schedule(x, y) {
    pending = [x, y];
    if (frame !== null) return;
    frame = requestAnimationFrame(() => {
      frame = null;
      const [px, py] = pending;
      const hit = layer.pick(px, py);

      considerFan(px, py, hit);

      element.style.cursor = hit ? 'pointer' : '';
      if (pinned) return;                 // a pinned popup owns the panel until dismissed

      if (hit) {
        if (layer.highlight(hit.index)) render();
        show(hit);
      } else {
        if (layer.highlight(null)) render();
        hide();
      }
    });
  }

  // Once pinned the popup accepts the pointer so its text can be selected, which means
  // its events bubble to the stage. Without this guard, moving across a pinned popup
  // would pick whatever is behind it and clicking its text would dismiss it.
  const fromPopup = (e) => popup.contains(e.target);

  function onMove(e) {
    if (fromPopup(e)) return;
    if (downAt) {
      travelled += Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
      downAt = [e.clientX, e.clientY];
      // Mid-drag: the globe is turning, so nothing under the pointer is stable.
      if (travelled > opts.dragThreshold) {
        // Drop the inline cursor so the stage's own grab/grabbing styling shows through
        // -- an inline style would otherwise outrank it for the whole drag.
        element.style.cursor = '';
        // The fan was pinned to screen coordinates that the rotation has just invalidated.
        closeFan();
        if (!pinned) hide();
        if (layer.highlight(null)) render();
        return;
      }
    }
    const rect = rectOf();
    schedule(e.clientX - rect.left, e.clientY - rect.top);
  }

  function onDown(e) {
    if (fromPopup(e)) return;
    downAt = [e.clientX, e.clientY];
    travelled = 0;
  }

  function onUp(e) {
    if (fromPopup(e)) return;
    const wasDrag = travelled > opts.dragThreshold;
    downAt = null;
    travelled = 0;
    if (wasDrag) return;               // released from a globe drag, not a click

    const rect = rectOf();
    const hit = layer.pick(e.clientX - rect.left, e.clientY - rect.top);
    if (!hit) {
      clear();
      return;
    }

    // Clicking the pinned symbol again unpins it; clicking a different one moves the pin.
    pinned = !(pinned && shownIndex === hit.index);
    popup.classList.toggle(opts.pinnedClass, pinned);
    if (layer.highlight(hit.index)) render();
    show(hit);
    if (!pinned) hide();
  }

  function onLeave() {
    downAt = null;
    travelled = 0;
    element.style.cursor = '';
    cancelDwell();
    if (pinned) return;
    closeFan();
    hide();
    if (layer.highlight(null)) render();
  }

  // Zooming rescales every screen position, so the fan's captured anchor and its members'
  // true positions no longer line up. Collapse rather than draw leader lines to the wrong
  // places.
  function onWheel() {
    closeFan();
  }

  function onKey(e) {
    if (e.key === 'Escape') {
      if (pinned) clear();
      else closeFan();
    }
  }

  element.addEventListener('pointermove', onMove);
  element.addEventListener('pointerdown', onDown);
  element.addEventListener('pointerup', onUp);
  element.addEventListener('pointerleave', onLeave);
  element.addEventListener('wheel', onWheel, { passive: true });
  window.addEventListener('keydown', onKey);

  return {
    clear,
    closeFan,
    get pinned() { return pinned; },
    destroy() {
      element.removeEventListener('pointermove', onMove);
      element.removeEventListener('pointerdown', onDown);
      element.removeEventListener('pointerup', onUp);
      element.removeEventListener('pointerleave', onLeave);
      element.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKey);
      cancelDwell();
      if (frame !== null) cancelAnimationFrame(frame);
      if (ticker !== null) cancelAnimationFrame(ticker);
    },
  };
}
