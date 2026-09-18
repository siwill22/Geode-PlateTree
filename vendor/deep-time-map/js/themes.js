/**
 * Themes: named, coherent looks for map furniture.
 *
 * A Theme assigns one colour per ROLE, never per element. An element claims a
 * role and inherits every Theme for free; that indirection is the whole point,
 * because the set of drawable things keeps growing and a flat list of today's
 * colours would be stale on arrival. See Geode's docs/adr/0040.
 *
 * Roles, and what claims them today:
 *
 *   page          the surround behind everything (canvas clear colour)
 *   water         ocean / the globe disc
 *   land          continental fill
 *   outline       the coastline pen  (see `outline` treatment below)
 *   accentHot     ridges
 *   accentWarm    subduction zones
 *   accentBright  transforms
 *   accentMuted   "other" boundaries
 *   accentCool    velocity arrows
 *   rampFlow      [slow, fast] -- wind / current streaks
 *   rampTrack     [slow, fast] -- tracked particles
 *
 * rampFlow and rampTrack are separate on purpose: tracked particles and wind
 * streaks are simultaneously visible in Geode's Valdes and climate viewers, so
 * their distinguishability is load-bearing rather than redundant.
 *
 * WHAT A THEME MUST NOT DO: it never touches the colour ramp a Variable is
 * painted with. That ramp carries Colour Polarity -- which end is warm encodes
 * whether a positive anomaly is cold or hot -- so a decorative control able to
 * reach it could silently invert what a reader takes off the mantle. Furniture
 * only. See Geode's docs/adr/0038.
 *
 * Non-colour properties, deliberately bounded to three:
 *
 *   lightness  'light' | 'dark'  -- which way marks contrast, and the direction
 *              `outline: 'shade'` moves. Not called "polarity": Colour Polarity
 *              and Subduction Polarity both already exist, both binary and both
 *              invisible when wrong.
 *   weight     scalar over every stroke width and decoration size at once. One
 *              multiplier, so the tuned ratios (subduction > ridge > transform)
 *              survive by construction and a new element is drawn at the right
 *              weight without any Theme being edited.
 *   outline    'contrast' | 'shade' | 'none' -- how the coastline pen relates to
 *              the land fill. A relationship, not a colour, which is why it is a
 *              named choice rather than another role.
 *
 * `temperature` is descriptive, not rendered: it and `lightness` are the two
 * axes a plain-language request ("something light and warm") is filtered on.
 * The set covers all six cells, so such a request can never land on nothing.
 */

import { withLightnessOf } from './colour.js';

/** Every role name, in the order a legend or contact sheet should show them. */
export const ROLE_NAMES = [
  'page', 'water', 'land', 'outline',
  'accentHot', 'accentWarm', 'accentBright', 'accentMuted', 'accentCool',
];

export const RAMP_NAMES = ['rampFlow', 'rampTrack'];

export const THEMES = [
  {
    id: 'abyssal',
    name: 'Abyssal',
    description: 'Deep navy ocean under a pale cyan limb; warm accents reserved for the boundaries. The long-standing Geode look.',
    lightness: 'dark',
    temperature: 'cool',
    weight: 1,
    outline: 'contrast',
    roles: {
      page: '#070c16',
      water: '#0d1b2e',
      land: '#33566f',
      outline: '#e3f4f6',
      accentHot: '#cd2f36',
      accentWarm: '#e4935d',
      accentBright: '#fce439',
      accentMuted: '#9fb9d2',
      accentCool: '#068ff0',
      rampFlow: ['#1f5c7a', '#eaffff'],
      rampTrack: ['#2ea043', '#e6ffe9'],
    },
  },
  {
    id: 'ember',
    name: 'Ember',
    description: 'Dark, warm and volcanic: near-black basalt water, ochre land, embers for the boundaries.',
    lightness: 'dark',
    temperature: 'warm',
    weight: 1,
    outline: 'contrast',
    roles: {
      page: '#120b08',
      water: '#1e1410',
      land: '#5c4028',
      outline: '#aa988a',
      accentHot: '#b80068',
      accentWarm: '#ea5f32',
      accentBright: '#ffc077',
      accentMuted: '#dab5df',
      accentCool: '#028f98',
      rampFlow: ['#7a3a1f', '#ffe9cf'],
      rampTrack: ['#3f9e6a', '#dcffe9'],
    },
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Neutral dark greys with no colour cast at all, so a painted field is the only hue on screen.',
    lightness: 'dark',
    temperature: 'neutral',
    weight: 1,
    outline: 'contrast',
    roles: {
      page: '#0c0c0d',
      water: '#1a1b1d',
      land: '#4a4d51',
      outline: '#adcefe',
      accentHot: '#82494e',
      accentWarm: '#a3857a',
      accentBright: '#e3deb4',
      accentMuted: '#a9b2b6',
      accentCool: '#59819c',
      rampFlow: ['#3a4247', '#eef3f6'],
      rampTrack: ['#3f9457', '#e3f7e8'],
    },
  },
  {
    id: 'parchment',
    name: 'Parchment',
    description: 'Aged paper and sepia ink, with the coastline drawn as a darker shade of the land rather than a contrasting pen.',
    lightness: 'light',
    temperature: 'warm',
    weight: 1,
    outline: 'shade',
    roles: {
      page: '#efe3c8',
      water: '#e0cfab',
      land: '#c9b287',
      outline: '#342819',
      accentHot: '#a10246',
      accentWarm: '#ac5d2d',
      accentBright: '#d7aa47',
      accentMuted: '#878aa3',
      accentCool: '#025e8f',
      rampFlow: ['#9c8a5f', '#3c2f18'],
      rampTrack: ['#7fa06a', '#1f3d18'],
    },
  },
  {
    id: 'frost',
    name: 'Frost',
    description: 'A pale, cool daylight map: near-white land on ice-blue water, with saturated ink for the boundaries.',
    lightness: 'light',
    temperature: 'cool',
    weight: 1,
    outline: 'contrast',
    roles: {
      page: '#eef4f8',
      water: '#cfe3ef',
      land: '#f5f8f9',
      outline: '#3e535f',
      accentHot: '#780022',
      accentWarm: '#a1742a',
      accentBright: '#b0bf2d',
      accentMuted: '#73a1bf',
      accentCool: '#356be2',
      rampFlow: ['#9fc3d8', '#123a52'],
      rampTrack: ['#74b087', '#0f3d23'],
    },
  },
  {
    id: 'newsprint',
    name: 'Newsprint',
    description: 'Neutral light greys for print and projection, where a figure may end up photocopied.',
    lightness: 'light',
    temperature: 'neutral',
    weight: 1,
    outline: 'shade',
    roles: {
      page: '#f4f4f3',
      water: '#e2e3e3',
      land: '#c4c5c4',
      outline: '#2a2f32',
      accentHot: '#aa111a',
      accentWarm: '#927764',
      accentBright: '#bfb699',
      accentMuted: '#92969b',
      accentCool: '#5e6978',
      rampFlow: ['#a9adae', '#2b3133'],
      rampTrack: ['#7da586', '#1d3a26'],
    },
  },

  // --- above the grid floor: characterful extras ---------------------------

  {
    id: 'playroom',
    name: 'Playroom',
    description: 'Thick, bright and unmistakable — heavy boundary lines and large subduction triangles, for teaching and for children.',
    lightness: 'light',
    temperature: 'warm',
    weight: 1.7,
    outline: 'contrast',
    roles: {
      page: '#fff8e8',
      water: '#7fd4ee',
      land: '#ffd98a',
      outline: '#443932',
      accentHot: '#b72200',
      accentWarm: '#d68303',
      accentBright: '#fad504',
      accentMuted: '#6db0b9',
      accentCool: '#0063d7',
      rampFlow: ['#4aa8c8', '#08304a'],
      rampTrack: ['#39a85a', '#08351a'],
    },
  },
  {
    id: 'blueprint',
    name: 'Blueprint',
    description: 'A technical drawing: cyanotype blue throughout, continents outlined in a lighter shade of themselves.',
    lightness: 'dark',
    temperature: 'cool',
    weight: 0.85,
    outline: 'shade',
    roles: {
      page: '#07223a',
      water: '#0e3559',
      land: '#1d5480',
      outline: '#d9eff3',
      accentHot: '#bb3d78',
      accentWarm: '#fa8b8a',
      accentBright: '#e9f692',
      accentMuted: '#7da7b0',
      accentCool: '#32bbff',
      rampFlow: ['#2a6a94', '#e8faff'],
      rampTrack: ['#46a86a', '#e2ffe9'],
    },
  },
  {
    id: 'relief',
    name: 'Relief',
    description: 'A muted physical atlas: sage land on a quiet grey-blue sea, boundaries stated rather than shouted.',
    lightness: 'light',
    temperature: 'neutral',
    weight: 1.15,
    outline: 'shade',
    roles: {
      page: '#eceee9',
      water: '#c4d3d9',
      land: '#cbd6ba',
      outline: '#31332f',
      accentHot: '#9c4402',
      accentWarm: '#a67f5a',
      accentBright: '#b6ca70',
      accentMuted: '#85a0a0',
      accentCool: '#0274a4',
      rampFlow: ['#93aeb8', '#16343f'],
      rampTrack: ['#7ca173', '#1b3a1c'],
    },
  },
];

export const DEFAULT_THEME_ID = 'abyssal';

export function themeById(id) {
  const t = THEMES.find((x) => x.id === id);
  if (!t) {
    throw new Error(
      `unknown theme '${id}' -- known: ${THEMES.map((x) => x.id).join(', ')}`,
    );
  }
  return t;
}

/** Filter by the two declared axes; either may be omitted. */
export function findThemes({ lightness, temperature } = {}) {
  return THEMES.filter(
    (t) => (!lightness || t.lightness === lightness)
      && (!temperature || t.temperature === temperature),
  );
}

/**
 * The coastline pen for a Theme, resolving Outline Treatment.
 * Returns null for `'none'` -- callers hide the pen rather than draw it in the
 * fill colour, which would leave an invisible seam the depth buffer still pays
 * for.
 */
export function outlineColour(theme) {
  switch (theme.outline) {
    case 'none': return null;
    // Land's hue and chroma, at the lightness the Theme reserved for its pen.
    // `roles.outline` therefore always means "where the pen sits in
    // lightness"; the treatment decides whether it also takes its HUE from
    // there ('contrast') or from the land ('shade').
    case 'shade': return withLightnessOf(theme.roles.land, theme.roles.outline);
    case 'contrast': return theme.roles.outline;
    default: throw new Error(`unknown outline treatment '${theme.outline}'`);
  }
}

/**
 * A complete deep-time-map boundary `style` for a Theme.
 *
 * COMPLETE per type, deliberately. BoundaryLayer merges caller style over
 * DEFAULT_STYLE SHALLOWLY (`{...DEFAULT_STYLE, ...options.style}`), so a
 * partial per-type object such as `{ridge: {stroke}}` replaces the whole entry
 * and silently drops its `width`. Every entry below carries stroke, width and
 * label together for that reason.
 */
export function boundaryStyle(theme) {
  const w = theme.weight;
  const r = theme.roles;
  return {
    subduction: { stroke: r.accentWarm, width: 1.9 * w, label: 'Subduction zone' },
    ridge: { stroke: r.accentHot, width: 1.5 * w, label: 'Mid-ocean ridge' },
    transform: { stroke: r.accentBright, width: 1.3 * w, label: 'Transform' },
    other: { stroke: r.accentMuted, width: 1.0 * w, label: 'Other boundary' },
  };
}

/** Boundary decoration sizes for a Theme -- scaled together, so triangles grow
 *  without crowding. Gap and size share one multiplier for that reason. */
export function boundaryDecoration(theme) {
  return {
    triangleGap: 24.2 * theme.weight,
    triangleSize: 10.125 * theme.weight,
  };
}

/** Velocity arrow options for a Theme. `scale`/`minSpeed` are untouched: they
 *  are calibrated against real plate speeds, not aesthetics. */
export function velocityStyle(theme) {
  const w = theme.weight;
  return {
    colour: theme.roles.accentCool,
    headLength: 6 * w,
    headWidth: 4.5 * w,
    shaftWidth: 1.3 * w,
  };
}

/**
 * Which role pairs must be mutually distinguishable for a given Theme.
 *
 * Not a fixed list: it depends on the Theme. With `outline: 'none'` there is no
 * pen, so land and water carry the whole land-sea distinction themselves and
 * must clear the threshold; with a pen present the outline carries it and they
 * need not. See Geode's docs/adr/0041.
 */
export function coOccurringPairs(theme) {
  const accents = ['accentHot', 'accentWarm', 'accentBright', 'accentMuted', 'accentCool'];
  const pairs = [];
  for (let i = 0; i < accents.length; i++) {
    for (let j = i + 1; j < accents.length; j++) pairs.push([accents[i], accents[j]]);
  }
  // The pen shares the map with every accent.
  if (theme.outline !== 'none') {
    for (const a of accents) pairs.push(['outline', a]);
  } else {
    pairs.push(['land', 'water']);
  }
  return pairs;
}
