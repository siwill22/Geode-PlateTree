import {
  THEMES, DEFAULT_THEME_ID, themeById, findThemes, outlineColour,
  boundaryStyle, boundaryDecoration, velocityStyle,
} from '../../vendor/petrify/js/index.js';

/**
 * Themes, Geode side: turning the vendored table's role colours into the
 * numbers three.js wants, and into a live re-style path.
 *
 * The TABLE is not here on purpose -- it lives in the vendored library, next to
 * the `DEFAULT_STYLE` it generalises, because five of the nine themed colours
 * (four boundary strokes plus velocity arrows) already belonged to that library
 * and Geode's own four were picked to match them. See docs/adr/0039. What lives
 * here is the wiring, which is expected to differ per consumer: Geode resolves
 * roles into shader uniforms and a renderer clear colour, StoryMaps resolves the
 * same roles into 2D canvas styles.
 *
 * THERE IS NO `PALETTE` ANY MORE. It was deleted rather than left as a default,
 * so nothing can import a hardcoded scene colour: an element receives resolved
 * role colours or it renders nothing. See docs/adr/0040 and
 * scripts/check_theme_roles.mjs, which enforces that with an allowlist of the
 * handful of deliberate exceptions.
 */

export type ThemeId = string;
export type Lightness = 'light' | 'dark';
export type Temperature = 'warm' | 'cool' | 'neutral';
export type OutlineTreatment = 'contrast' | 'shade' | 'none';

export interface ThemeRoles {
  page: string;
  water: string;
  land: string;
  outline: string;
  accentHot: string;
  accentWarm: string;
  accentBright: string;
  accentMuted: string;
  accentCool: string;
  rampFlow: [string, string];
  rampTrack: [string, string];
}

export interface Theme {
  id: ThemeId;
  name: string;
  description: string;
  lightness: Lightness;
  temperature: Temperature;
  weight: number;
  outline: OutlineTreatment;
  roles: ThemeRoles;
}

export const ALL_THEMES: Theme[] = THEMES as Theme[];
export const DEFAULT_THEME: ThemeId = DEFAULT_THEME_ID as string;

export function getTheme(id: ThemeId): Theme {
  return themeById(id) as Theme;
}

/** Filter on the two declared axes -- what a plain-language request resolves
 *  through ("something light and warm"). See docs/adr/0038. */
export function themesMatching(q: { lightness?: Lightness; temperature?: Temperature }): Theme[] {
  return findThemes(q) as Theme[];
}

/** `0xrrggbb` for three.js, from a `#rrggbb` role. */
export function hexNumber(hex: string): number {
  return parseInt(hex.replace(/^#/, ''), 16);
}

/**
 * A Theme resolved into exactly what Geode's renderers consume. Computed once
 * per Theme change rather than per frame, and deliberately flat: a consumer
 * should never have to know whether a colour was authored or derived.
 */
export interface ResolvedTheme {
  readonly theme: Theme;
  /** Renderer clear colour. */
  readonly page: number;
  readonly water: number;
  readonly land: number;
  /** null when Outline Treatment is 'none' -- callers HIDE the pen rather than
   *  draw it in the fill colour, which would leave an invisible seam the depth
   *  buffer still pays for. */
  readonly outline: number | null;
  readonly accents: {
    hot: number; warm: number; bright: number; muted: number; cool: number;
  };
  readonly rampFlow: [number, number];
  readonly rampTrack: [number, number];
  /** Multiplier over every stroke width and decoration size. */
  readonly weight: number;
  readonly lightness: Lightness;
  /** Ready to hand to petrify's BoundarySeries -- complete per type. */
  readonly boundaryStyle: Record<string, { stroke: string; width: number; label: string }>;
  readonly boundaryDecoration: { triangleGap: number; triangleSize: number };
  readonly velocityStyle: Record<string, unknown>;
}

export function resolveTheme(id: ThemeId): ResolvedTheme {
  const theme = getTheme(id);
  const r = theme.roles;
  const pen = outlineColour(theme) as string | null;
  return {
    theme,
    page: hexNumber(r.page),
    water: hexNumber(r.water),
    land: hexNumber(r.land),
    outline: pen === null ? null : hexNumber(pen),
    accents: {
      hot: hexNumber(r.accentHot),
      warm: hexNumber(r.accentWarm),
      bright: hexNumber(r.accentBright),
      muted: hexNumber(r.accentMuted),
      cool: hexNumber(r.accentCool),
    },
    rampFlow: [hexNumber(r.rampFlow[0]), hexNumber(r.rampFlow[1])],
    rampTrack: [hexNumber(r.rampTrack[0]), hexNumber(r.rampTrack[1])],
    weight: theme.weight,
    lightness: theme.lightness,
    boundaryStyle: boundaryStyle(theme),
    boundaryDecoration: boundaryDecoration(theme),
    velocityStyle: velocityStyle(theme),
  };
}

/**
 * Something that can be re-styled when the Theme changes.
 *
 * Implemented rather than inherited -- the same reasoning as
 * core/multiInstanceHost.ts's HostedInstance: an existing class grows one
 * method rather than adopting a base class.
 */
export interface Themeable {
  applyTheme(theme: ResolvedTheme): void;
}

/**
 * Chrome (lil-gui panels, status readouts) follows a Theme's LIGHTNESS only,
 * never its roles -- see docs/adr/0038. Stamped on <html> so plain CSS can
 * respond without any element subscribing.
 *
 * This is the one place Lightness reaches outside the scene, and it is why the
 * flag exists at all: the chrome is CSS, outside the role system, with nothing
 * else to consult. A parchment map under a near-black panel is the case that
 * forced it.
 */
export function applyChromeLightness(lightness: Lightness): void {
  document.documentElement.dataset.themeLightness = lightness;
}
