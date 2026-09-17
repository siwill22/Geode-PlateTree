/** How many discrete positions a clip-range slider divides a variable's
 *  encoded span into. */
const CLIP_SLIDER_STEPS = 500;

/**
 * A slider step sized to `steps` divisions of [encodeMin, encodeMax].
 *
 * MUST be recomputed and re-applied via Controller.step() every time the
 * active variable changes, alongside min()/max() -- a step left over from
 * whichever variable was active BEFORE can dwarf a narrow one's entire
 * range. Ocean vertical velocity's encode_min/encode_max are only 0.0016
 * cm/s apart; several clip controls in this codebase left `step` fixed at
 * whatever the constructor originally set it to (0.1, tuned for wide
 * variables like temperature) and never revisited it in setVariable(). The
 * result: every drag overshot past the OTHER bound and got clamped straight
 * back, so the slider looked frozen at one end no matter which way you
 * dragged it.
 *
 * Falls back to 1 for a zero-width range (encode_min == encode_max), since
 * lil-gui rejects a step of 0.
 */
export function clipSliderStep(encodeMin: number, encodeMax: number, steps = CLIP_SLIDER_STEPS): number {
  return (encodeMax - encodeMin) / steps || 1;
}

/**
 * Keep clipMin <= clipMax after either one changes.
 *
 * lil-gui only clamps a slider against ITS OWN min/max -- both clip
 * controls in every viewer share the same bounds (the variable's full
 * encode_min/encode_max), so nothing stops one being dragged past the
 * OTHER's current value. A crossed range (min > max) is meaningless: the
 * shader clips against whichever of the two it reads as lo vs hi, so the
 * visible result is either "everything" or "nothing" depending on which
 * that happens to be, not the narrowed range the crossing looked like it
 * was asking for.
 *
 * Pulls the OTHER bound along to match rather than rejecting the input, so
 * dragging min past max collapses the range to a single value at the
 * crossing point instead of refusing to move at all. Only mutates `state`;
 * callers still own refreshing whichever Controller displays the pulled
 * value (`updateDisplay()`) and re-invoking their own onClip callback --
 * this has no Controller reference itself, since each viewer wires that
 * differently (log/linear proxies in one, fixed halves in another).
 *
 * Returns whether it had to correct the sibling, so the caller knows
 * whether that refresh is actually needed.
 */
export function clampClipOrder(
  state: { clipMin: number; clipMax: number },
  changed: 'min' | 'max',
): boolean {
  if (changed === 'min' && state.clipMin > state.clipMax) {
    state.clipMax = state.clipMin;
    return true;
  }
  if (changed === 'max' && state.clipMax < state.clipMin) {
    state.clipMin = state.clipMax;
    return true;
  }
  return false;
}
