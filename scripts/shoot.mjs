// Screenshot the viewer at a few ages, and report what the page itself says
// about the tree at each one. Run against a dev server or a preview build:
//   node scripts/shoot.mjs http://localhost:5180/GeodeViewers/PlateTree/ shots
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5180/GeodeViewers/PlateTree/';
const outDir = process.argv[3] ?? 'shots';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__platetree?.ready === true, { timeout: 90_000 });

const ages = [0, 100, 250, 500, 1000, 1800];
for (const age of ages) {
  await page.evaluate((a) => window.__platetree.setAge(a), age);
  await page.waitForTimeout(700);
  const stats = await page.evaluate(() => window.__platetree.stats());
  console.log(
    `age ${String(age).padStart(4)} Ma  plates ${String(stats.plates).padStart(3)}  `
    + `links ${String(stats.links).padStart(3)}  patched ${String(stats.patched).padStart(3)}  `
    + `groups ${String(stats.groups).padStart(3)}  roots [${stats.roots.join(', ')}]`,
  );
  await page.screenshot({ path: `${outDir}/age-${String(age).padStart(4, '0')}.png` });
}

// A circuit at 100 Ma, to prove the panel and the anchor hop work.
await page.evaluate((a) => window.__platetree.setAge(a), 100);
await page.waitForTimeout(400);
const stats = await page.evaluate(() => window.__platetree.stats());
const probe = await page.evaluate(() => {
  // deepest circuit at this age, which is the interesting one to show
  const s = window.__platetree.stats();
  let best = null;
  for (const pid of window.__platetree.presentPlates?.() ?? []) {
    window.__platetree.select(pid);
    const c = window.__platetree.circuit();
    if (c && (!best || c.length > best.length)) best = c;
  }
  return { best, s };
});
if (probe.best) {
  console.log(`\ndeepest circuit at 100 Ma (${probe.best.length - 1} rotations):`);
  console.log('  ' + probe.best.join(' -> '));
}
await page.screenshot({ path: `${outDir}/circuit-100.png` });

console.log(`\ntotal exported ages: ${await page.evaluate(() => window.__platetree.ages())}`);
console.log(errors.length ? `\nCONSOLE ERRORS:\n${errors.join('\n')}` : '\nno console errors');

await browser.close();
