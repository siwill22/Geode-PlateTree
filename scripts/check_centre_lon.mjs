/**
 * Two claims about the central meridian, measured rather than eyeballed.
 *
 * 1. It slides the map SIDEWAYS. A rotation about the pole changes no latitude,
 *    and both flat Projections draw parallels as straight horizontal lines, so
 *    every Tree Node's screen y must be unchanged by it. This is the check that
 *    would have caught the geographic/render frame mix-up: a rotation about the
 *    wrong axis swings nodes through latitude, which shows up here as a large
 *    dy while the coastlines underneath still look right.
 *
 * 2. Dragging moves the ground WITH the pointer. A drag of N pixels must move a
 *    node N pixels, at whatever zoom -- not some fixed number of degrees.
 *
 *    Measured near the EQUATOR. Plate Carrée has one horizontal scale
 *    everywhere, but Robinson's shrinks towards the poles -- a degree of
 *    longitude is about 0.53 of its equatorial width at 60 degrees -- so a
 *    high-latitude node genuinely cannot keep up with the pointer and a median
 *    over the whole map is guaranteed to fall short. The equator is the one
 *    parallel where "the ground follows the pointer" is a well-posed claim, and
 *    it is where degreesPerPixel is defined.
 */
import { chromium } from 'playwright';

const URL = process.env.URL ?? 'http://localhost:5180/GeodeViewers/PlateTree/';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__platetree?.ready === true, { timeout: 90_000 });

const settle = () => page.waitForTimeout(500);
const nodes = () => page.evaluate(() => window.__platetree.nodeScreens());

let failures = 0;
const check = (ok, line) => { if (!ok) failures++; console.log(`${ok ? 'ok  ' : 'FAIL'}  ${line}`); };

for (const proj of ['robinson', 'plateCarree']) {
  await page.evaluate((p) => window.__platetree.setProjection(p), proj);
  await page.evaluate(() => window.__platetree.setCentreLon(0));
  await settle();
  const before = await nodes();

  for (const lon of [30, 90, -150]) {
    await page.evaluate((l) => window.__platetree.setCentreLon(l), lon);
    await settle();
    const after = await nodes();

    let maxDy = 0, maxDx = 0, n = 0;
    for (const [id, [x, y]] of Object.entries(after)) {
      const b = before[id];
      if (!b) continue;
      n++;
      maxDy = Math.max(maxDy, Math.abs(y - b[1]));
      maxDx = Math.max(maxDx, Math.abs(x - b[0]));
    }
    // A node that wrapped the seam moves a long way in x -- that is the point.
    // In y it must not move at all; 1 px covers rounding in the readback.
    check(n > 200 && maxDy < 1,
      `${proj.padEnd(11)} centre ${String(lon).padStart(4)}°  `
      + `${n} nodes tracked  max |dy| ${maxDy.toFixed(2)} px  max |dx| ${maxDx.toFixed(0)} px`);
  }
  await page.evaluate(() => window.__platetree.setCentreLon(0));
}

// --- drag ---------------------------------------------------------------
// The camera looks at the middle of the map, so the equator runs across the
// middle of the viewport at any zoom centred there.
const EQUATOR_Y = 450;
const BAND_PX = 40;

for (const proj of ['plateCarree', 'robinson']) {
  await page.evaluate((p) => window.__platetree.setProjection(p), proj);
  for (const [dx, zoomSteps] of [[240, 0], [-360, 0], [240, 3]]) {
    await page.evaluate(() => window.__platetree.setCentreLon(0));
    await settle();
    if (zoomSteps) {
      await page.mouse.move(700, EQUATOR_Y);
      for (let i = 0; i < zoomSteps; i++) await page.mouse.wheel(0, -240);
      await settle();
    }
    const degPerPx = await page.evaluate(() => window.__platetree.degreesPerPixel());
    const before = await nodes();

    await page.mouse.move(700, EQUATOR_Y);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(700 + (dx * i) / 8, EQUATOR_Y);
    await page.mouse.up();
    await settle();

    const lon = await page.evaluate(() => window.__platetree.centreLon());
    const after = await nodes();

    // Median over near-equatorial nodes that did not wrap the seam -- so
    // neither one wrapped node nor the poleward squeeze can carry the result.
    const moves = [];
    for (const [id, [x, y]] of Object.entries(after)) {
      const b = before[id];
      if (!b || Math.abs(y - EQUATOR_Y) > BAND_PX) continue;
      const d = x - b[0];
      if (Math.abs(d - dx) < 200) moves.push(d);
    }
    moves.sort((a, b) => a - b);
    const median = moves[Math.floor(moves.length / 2)];

    check(moves.length > 15 && Math.abs(median - dx) < 6,
      `${proj.padEnd(11)} drag ${String(dx).padStart(5)} px  zoom×${zoomSteps}  `
      + `${String(degPerPx.toFixed(4)).padStart(7)} deg/px  centre now ${lon.toFixed(1)}°  `
      + `ground moved ${median?.toFixed(1)} px (${moves.length} equatorial nodes)`);
  }
}

// The globe must be untouched by any of this: left-drag still orbits, and no
// central meridian is applied there.
await page.evaluate(() => window.__platetree.setCentreLon(0));
await page.evaluate(() => window.__platetree.setProjection('globe'));
await settle();
const g0 = await nodes();
await page.mouse.move(700, 450);
await page.mouse.down();
for (let i = 1; i <= 8; i++) await page.mouse.move(700 + i * 15, 450);
await page.mouse.up();
await settle();
const g1 = await nodes();
const orbited = Object.keys(g1).some((id) => g0[id] && Math.abs(g1[id][0] - g0[id][0]) > 20);
const centreOnGlobe = await page.evaluate(() => window.__platetree.centreLon());
check(orbited && centreOnGlobe === 0,
  `globe       left-drag still orbits (nodes moved: ${orbited}), centre untouched (${centreOnGlobe}°)`);

console.log(errs.length ? `\nERRORS:\n${errs.join('\n')}` : '\nno console errors');
await browser.close();
process.exit(failures ? 1 : 0);
