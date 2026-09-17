import { defineConfig } from 'vite';

// GitHub Pages serves this repo at <user>.github.io/GeodeViewers/, and each
// viewer lives in its own subdirectory so siblings can be added later without
// any of them moving. Overridable for local preview and for a different host.
const base = process.env.VITE_BASE ?? '/GeodeViewers/PlateTree/';

export default defineConfig({
  base,
  build: { target: 'es2022' },
});
