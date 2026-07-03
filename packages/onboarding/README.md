# @kitbash/onboarding

Spotlight tours for React: dim the screen, cut a bright rounded hole around one element, ring it,
and float a small card next to it (icon + title + body + Next/Got-it/Back/Skip). Multi-step,
dependency-free, tracks the target through scroll/resize/size changes, shows once per user.

## Wire

Declarative auto-once tour (shows ~0.4s after mount, only if `storageKey` was never marked seen):

```tsx
import { useRef } from 'react';
import { Spotlight, SpotlightEditIcon } from '@kitbash/onboarding';

function Dashboard() {
  const libraryRef = useRef<HTMLElement>(null);

  return (
    <>
      <section ref={libraryRef}>{/* library grid */}</section>
      <aside data-tour="stats-panel">{/* stats */}</aside>

      <Spotlight
        storageKey="dashboard-tour"
        steps={[
          { target: libraryRef, icon: <SpotlightEditIcon />, title: 'Your library', body: 'Everything you make lands here.' },
          { target: '[data-tour="stats-panel"]', title: 'Live stats', body: 'Watch results roll in.', placement: 'left' },
        ]}
        labels={{ next: 'Next', done: 'Got it', back: 'Back', skip: 'Skip', close: 'Dismiss' }}
      />
    </>
  );
}
```

Replay from a button with `useSpotlight` (render `tour.element` once):

```tsx
import { useSpotlight, resetSpotlight, type SpotlightStep } from '@kitbash/onboarding';

function HelpButton({ steps }: { steps: SpotlightStep[] }) {
  const tour = useSpotlight({ labels: { next: 'Next', done: 'Got it' } });
  return (
    <>
      <button onClick={() => tour.start(steps, { force: true })}>Replay tour</button>
      {tour.element}
    </>
  );
}
```

## Env vars

None — pure UI.

## Notes

- SSR-safe: portals to `document.body` only after mount; all `window`/`document` access guarded.
- `prefers-reduced-motion` honored: the hole jumps instead of gliding; pulse/pop animations off.
- Theme via CSS custom properties (set them on `:root` or any ancestor of `body`):
  `--kb-spot-dim-color`, `--kb-spot-accent`, `--kb-spot-card-bg`, `--kb-spot-card-fg`,
  `--kb-spot-muted`, `--kb-spot-border`, `--kb-spot-font`.
- `zIndex` prop (default 80) stacks the overlay wherever your app needs it.
- Once-per-user: ANY close (complete or skip) marks `storageKey` seen in localStorage
  (`kitbash.onboarding.<key>`, in-memory fallback when storage is blocked). Replay with
  `resetSpotlight(key)` or the `force` prop; `hasSeenSpotlight`/`markSpotlightSeen` are exported
  for custom flows.
