import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
mkdirSync('shots-proj', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto('http://localhost:5180/GeodeViewers/PlateTree/', { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__platetree?.ready === true, { timeout: 90_000 });

const shot = async (name) => { await page.waitForTimeout(800); await page.screenshot({ path: `shots-proj/${name}.png` }); };

// projections
for (const proj of ['robinson', 'plateCarree', 'globe']) {
  await page.evaluate((p) => window.__platetree.setProjection(p), proj);
  await page.evaluate(() => window.__platetree.setAge(0));
  await shot(`${proj}-0`);
}

// central meridian sweep on Robinson
await page.evaluate(() => window.__platetree.setProjection('robinson'));
for (const lon of [-120, 0, 120]) {
  await page.evaluate((l) => window.__platetree.setCentreLon(l), lon);
  await shot(`centre-${lon}`);
}
await page.evaluate(() => window.__platetree.setCentreLon(0));

// static vs topological tree
for (const src of ['static', 'topological']) {
  await page.evaluate((s) => window.__platetree.setTreeSource(s), src);
  for (const age of [0, 200]) {
    await page.evaluate((a) => window.__platetree.setAge(a), age);
    await page.waitForTimeout(600);
    const st = await page.evaluate(() => window.__platetree.stats());
    const mode = await page.evaluate(() => window.__platetree.nodeMode());
    console.log(`${src.padEnd(12)} ${String(age).padStart(4)} Ma  nodeMode=${mode.padEnd(7)} `
      + `plates ${String(st.plates).padStart(3)}  links ${String(st.links).padStart(3)}  `
      + `patched ${String(st.patched).padStart(3)}  groups ${String(st.groups).padStart(3)}  roots [${st.roots.join(', ')}]`);
    await shot(`${src}-${age}`);
  }
}

// mosaic off, for comparison
await page.evaluate(() => window.__platetree.setTreeSource('static'));
await page.evaluate(() => window.__platetree.setAge(0));
await page.evaluate(() => window.__platetree.setShowPlates(false));
await shot('mosaic-off');

console.log(errs.length ? `\nERRORS:\n${errs.join('\n')}` : '\nno console errors');
await browser.close();
