import { defineConfig } from 'vite';

// GitHub Pages serves this repo at <user>.github.io/Geode-PlateTree/.
// Overridable for local preview and for a different host.
const base = process.env.VITE_BASE ?? '/Geode-PlateTree/';

export default defineConfig({
  base,
  build: { target: 'es2022' },
});
