import type { MultiGlobeConfig } from './tools';

/**
 * Wire the static `#globe-menu-toggle`/`#globe-menu` markup (see
 * core/multiGlobeMenu.css, and globe.html for the reference markup) to a
 * recipe's opt-in Multi-Globe capability (docs/adr/0022).
 *
 * Shared by all four generator wrapper types (globe/, groupGlobe/,
 * reconstruction/, reconstructionGroup/), which were each independently
 * duplicating this identically -- the very drift this function exists to
 * stop. climate/main.ts and tomography/main.ts wire their own version
 * directly instead of calling this: Multi-Globe there is unconditional
 * (nothing to gate on), and tomography also broadcasts a second Synced
 * Field (depth slice) this helper doesn't know about.
 *
 * `onSyncAgeInit`/`onSyncAgeChange` are separate, not one callback, because
 * they run at genuinely different moments: init happens at module-eval
 * time, before any instance exists, so it must not touch host.broadcast;
 * a user's own toggle happens once at least one instance is guaranteed to
 * exist. Merging them would either crash on boot or silently skip the
 * initial sync depending on which behaviour "won".
 */
export function wireMultiGlobeMenu(
  multiGlobe: MultiGlobeConfig | undefined,
  onAddGlobe: () => void,
  onSyncAgeInit: (enabled: boolean) => void,
  onSyncAgeChange: (enabled: boolean) => void,
): void {
  document.getElementById('globe-menu-toggle')?.addEventListener('click', () => {
    const menu = document.getElementById('globe-menu');
    if (menu) menu.hidden = !menu.hidden;
  });

  if (!multiGlobe) return;

  const toggle = document.getElementById('globe-menu-toggle');
  if (toggle) toggle.hidden = false;

  document.getElementById('add-globe')?.addEventListener('click', onAddGlobe);

  const syncAgeCheckbox = document.getElementById('sync-age') as HTMLInputElement | null;
  if (syncAgeCheckbox) {
    syncAgeCheckbox.checked = multiGlobe.syncAge;
    onSyncAgeInit(multiGlobe.syncAge);
    syncAgeCheckbox.addEventListener('change', (e) => {
      onSyncAgeChange((e.target as HTMLInputElement).checked);
    });
  }
}
