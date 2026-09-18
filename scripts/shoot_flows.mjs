// Screenshot the Locked Group flow diagram (v2) at a few ages, and report
// what the page says about it. Run against a dev server or a preview build:
//   node scripts/shoot_flows.mjs http://localhost:5180/GeodeViewers/PlateTree/ shots-flows
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5180/GeodeViewers/PlateTree/';
const outDir = process.argv[3] ?? 'shots-flows';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });

const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.__platetree?.ready === true, { timeout: 90_000 });

await page.evaluate(() => window.__platetree.setShowFlows(true));
await page.waitForTimeout(500);

for (const age of [0, 250, 800, 1800]) {
  await page.evaluate((a) => window.__platetree.setAge(a), age);
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${outDir}/flows-age-${String(age).padStart(4, '0')}.png` });
}

await page.mouse.move(700, 830);
await page.waitForTimeout(300);
await page.screenshot({ path: `${outDir}/flows-hover.png` });

// The actual guarantee assignLineageHues() makes: no two non-OTHER bands in
// the SAME Checkpoint ever share a colour. Checked directly rather than
// trusted, across every Checkpoint the diagram drew, not just the ages
// screenshotted above.
const collisions = await page.evaluate(() => window.__platetree.flowColorCollisions());
console.log(collisions.length
  ? `COLOUR COLLISIONS:\n${JSON.stringify(collisions, null, 2)}`
  : 'no same-Checkpoint colour collisions');

console.log(errors.length ? `CONSOLE ERRORS:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
