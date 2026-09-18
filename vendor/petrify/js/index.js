/*
 * petrify -- plate reconstructions rendered in the browser.
 *
 * Layers talk to their host through one method:
 *
 *     project(vec3) -> [x, y, depth] | null
 *
 * Supply an Orthographic, or anything of your own that implements it.
 *
 * Note what is NOT here: ./hover.js, ./timeseries-panel.js, ./latitude-panel.js,
 * ./raster-globe.js and ./explorer.js, which wire pointer events to DOM elements or need a
 * WebGL context. They are the only modules that touch the DOM, and keeping them out of this
 * barrel means a consumer rendering headlessly or in a worker never loads them. Import them
 * directly if you want them.
 */

export { BoundaryLayer, BoundarySeries, DEFAULT_STYLE } from './boundaries.js';
export { VelocityField } from './velocities.js';
export { PointLayer } from './points.js';
export { AggregateLayer } from './aggregate.js';
export { PolygonLayer } from './polygons.js';
export {
  TimeSeriesSet, parseCsv, seriesFromCsv, timeColumn, MODES,
} from './timeseries.js';
export { Orthographic } from './orthographic.js';
export {
  Robinson, robinsonForward, robinsonInverse, meridianCrossing, wrapLonDelta,
  ROBINSON_X, ROBINSON_Y, ROBINSON_KX, ROBINSON_KY, ROBINSON_STEP,
} from './robinson.js';
export { tracePolyline, packLonLat } from './polyline.js';
export {
  quatFromPoleAngle, quatSlerp, quatToMat3, mat3Multiply, mat3Apply,
} from './rotations.js';
export {
  DEG, lonLatToVec3, vec3ToLonLat, tangentFrame,
  cross, normalise, tangentTowards, travel, leftOfTravel,
} from './sphere.js';
// camera.js's own `robinsonForward` is deliberately NOT re-exported: it takes a third
// `centreLonDeg` argument that ./robinson.js's same-named two-argument function does not,
// and one barrel cannot carry both. Import it from './camera.js' directly if you want the
// pannable form.
export {
  angularDistance, viewMatrix, cameraInterpolate,
  greatCirclePoints, smallCirclePoints,
  SPILHAUS_CENTER, spilhausViewMatrix, spilhausForward, spilhausInverse, spilhausGrid,
  ROBINSON_TABLE, ROBINSON_XSCALE, ROBINSON_YSCALE, robinsonForwardDelta,
} from './camera.js';

export {
  THEMES, ROLE_NAMES, RAMP_NAMES, DEFAULT_THEME_ID,
  themeById, findThemes, outlineColour,
  boundaryStyle, boundaryDecoration, velocityStyle, coOccurringPairs,
} from './themes.js';
export {
  hexToRgb, rgbToHex, hexToLab, labToHex, rgbToLab, labToRgb,
  lightnessOf, withLightnessOf, simulateCvd, ciede2000, distanceUnder,
} from './colour.js';
