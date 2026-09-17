/**
 * Colour space maths, in the library because two shipped features need it and
 * neither is a test: Theme's `outline: 'shade'` derives a pen colour from a
 * fill by moving it in L*, and the Theme legibility gate measures perceptual
 * distance (see themes.js, and Geode's docs/adr/0041).
 *
 * Everything here is plain sRGB <-> CIE Lab D65 plus CIEDE2000. No dependencies,
 * consistent with the rest of js/.
 *
 * On the CVD matrices: Machado, Oliveira & Fernandes (2009), severity 1.0,
 * applied in LINEAR RGB. They are the standard published simulation and they
 * approximate *appearance*; they are not a claim about how any individual sees.
 * They are used here to reject palettes that collapse, not to certify ones that
 * do not.
 */

export function hexToRgb(hex) {
  let h = String(hex).trim().replace(/^#/, '');
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  if (!/^[0-9a-fA-F]{6}$/.test(h)) throw new Error(`not a hex colour: ${hex}`);
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

export function rgbToHex(rgb) {
  const p = (v) => {
    const n = Math.round(Math.min(1, Math.max(0, v)) * 255);
    return n.toString(16).padStart(2, '0');
  };
  return `#${p(rgb[0])}${p(rgb[1])}${p(rgb[2])}`;
}

const srgbToLinear = (c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const linearToSrgb = (c) => {
  const x = Math.min(1, Math.max(0, c));
  return x <= 0.0031308 ? x * 12.92 : 1.055 * x ** (1 / 2.4) - 0.055;
};

const M_RGB_XYZ = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.0721750],
  [0.0193339, 0.1191920, 0.9503041],
];
const M_XYZ_RGB = [
  [3.2404542, -1.5371385, -0.4985314],
  [-0.9692660, 1.8760108, 0.0415560],
  [0.0556434, -0.2040259, 1.0572252],
];
const WHITE = [0.95047, 1.0, 1.08883];

const mul = (m, v) => m.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);

export function rgbToLab(rgb) {
  const lin = rgb.map(srgbToLinear);
  const xyz = mul(M_RGB_XYZ, lin).map((v, i) => v / WHITE[i]);
  const f = xyz.map((v) => (v > 216 / 24389 ? Math.cbrt(v) : (841 / 108) * v + 4 / 29));
  return [116 * f[1] - 16, 500 * (f[0] - f[1]), 200 * (f[1] - f[2])];
}

export function labToRgb(lab) {
  const fy = (lab[0] + 16) / 116;
  const fx = fy + lab[1] / 500;
  const fz = fy - lab[2] / 200;
  const inv = (t) => (t ** 3 > 216 / 24389 ? t ** 3 : (108 / 841) * (t - 4 / 29));
  const xyz = [inv(fx) * WHITE[0], inv(fy) * WHITE[1], inv(fz) * WHITE[2]];
  return mul(M_XYZ_RGB, xyz).map(linearToSrgb);
}

export const hexToLab = (hex) => rgbToLab(hexToRgb(hex));
export const labToHex = (lab) => rgbToHex(labToRgb(lab));

/** Lightness of a hex colour, 0..100. */
export const lightnessOf = (hex) => hexToLab(hex)[0];

/**
 * Take `hex`'s hue and chroma, at `reference`'s lightness.
 *
 * This is Outline Treatment `'shade'`: an atlas pen that reads as a darker (or,
 * on a dark Theme, lighter) version of the land it outlines, while landing at
 * exactly the lightness the Theme reserved for its pen.
 *
 * It replaced a fixed "move N units away from the page" offset, which failed
 * the legibility gate on every `shade` Theme for a structural reason worth
 * keeping: land is mid-lightness by nature, so a fixed offset put the pen in
 * the middle of the range, on top of whichever accent already occupied that
 * rung. Deriving hue but NOT lightness keeps the derived colour inside the
 * ladder the accents are spaced on. See Geode's docs/adr/0041.
 */
export function withLightnessOf(hex, reference) {
  const [, a, b] = hexToLab(hex);
  return labToHex([lightnessOf(reference), a, b]);
}

// --- colour-vision deficiency ------------------------------------------------

export const CVD_MATRICES = {
  normal: [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
  deuteranopia: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.011820, 0.042940, 0.968881],
  ],
  protanopia: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  tritanopia: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.303900],
  ],
};

/** Simulate `hex` as seen under `kind`, returning a hex string. */
export function simulateCvd(hex, kind) {
  const m = CVD_MATRICES[kind];
  if (!m) throw new Error(`unknown CVD kind: ${kind}`);
  const lin = hexToRgb(hex).map(srgbToLinear);
  return rgbToHex(mul(m, lin).map(linearToSrgb));
}

/**
 * CIEDE2000 between two Lab triples. Rough reading for this project: below 10
 * is easily confused at thin-stroke sizes, 10-20 marginal, above 20
 * comfortably distinct. Thin lines on a busy background need more separation
 * than large patches, so those bands are generous rather than strict.
 */
export function ciede2000(lab1, lab2) {
  const [L1, a1, b1] = lab1;
  const [L2, a2, b2] = lab2;
  const rad = Math.PI / 180;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Cb ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) / rad + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) / rad + 360) % 360;

  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * rad) / 2);

  const Lbp = (L1 + L2) / 2;
  const Cbp = (C1p + C2p) / 2;
  let hbp;
  if (C1p * C2p === 0) hbp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= 180) hbp = (h1p + h2p) / 2;
  else hbp = h1p + h2p < 360 ? (h1p + h2p + 360) / 2 : (h1p + h2p - 360) / 2;

  const T = 1
    - 0.17 * Math.cos((hbp - 30) * rad)
    + 0.24 * Math.cos(2 * hbp * rad)
    + 0.32 * Math.cos((3 * hbp + 6) * rad)
    - 0.20 * Math.cos((4 * hbp - 63) * rad);

  const Sl = 1 + (0.015 * (Lbp - 50) ** 2) / Math.sqrt(20 + (Lbp - 50) ** 2);
  const Sc = 1 + 0.045 * Cbp;
  const Sh = 1 + 0.015 * Cbp * T;
  const Cbp7 = Cbp ** 7;
  const Rt = -2 * Math.sqrt(Cbp7 / (Cbp7 + 25 ** 7))
    * Math.sin(60 * Math.exp(-(((hbp - 275) / 25) ** 2)) * rad);

  return Math.sqrt(
    (dLp / Sl) ** 2 + (dCp / Sc) ** 2 + (dHp / Sh) ** 2
    + Rt * (dCp / Sc) * (dHp / Sh),
  );
}

/** CIEDE2000 between two hex colours as seen under `kind`. */
export function distanceUnder(hexA, hexB, kind = 'normal') {
  return ciede2000(
    hexToLab(simulateCvd(hexA, kind)),
    hexToLab(simulateCvd(hexB, kind)),
  );
}
