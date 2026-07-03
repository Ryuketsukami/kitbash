'use client';

/**
 * Spotlight onboarding tours.
 *
 * Dim the whole screen, cut a bright rounded hole around one target element, ring it, and float a
 * small card next to it (icon + title + body + Next/Got-it). Supports multi-step tours; a single
 * highlight is just a tour of length 1.
 *
 * Design notes
 * - The veil is ONE full-viewport SVG path with `fill-rule="evenodd"`: the hole is cut out of both
 *   the paint AND the hit-test, so click-through steps need no extra work.
 * - The hole glides between steps via a rAF exponential chase toward the *live* target rect, so it
 *   stays glued through smooth scrolling, window resizes, and targets that move while animating.
 * - All styling is injected via one <style> string, namespaced `kb-spot-*`, themable through
 *   `--kb-spot-*` CSS custom properties (every use has a fallback). Zero dependencies.
 * - i18n-agnostic: every visible string arrives through `labels` / step props, already translated.
 * - SSR-safe: portals to document.body only after mount; all window/document access is guarded.
 * - Reduced motion: hole movement jumps instead of gliding; ring pulse, card pop and the edit-icon
 *   animation are disabled via the injected media query.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type SVGProps,
} from 'react';
import { createPortal } from 'react-dom';

export type SpotlightPlacement = 'auto' | 'top' | 'bottom' | 'left' | 'right' | 'center';

/**
 * Anything the spotlight can aim at. Re-resolved on every reposition, so late-mounting targets are
 * picked up automatically:
 * - a CSS selector string (`'#hero'`, `'[data-tour="library"]'`),
 * - a DOM Element,
 * - a React ref object,
 * - any `getBoundingClientRect`-able object (virtual element for arbitrary regions),
 * - a getter function returning an Element (for targets that mount late / swap identity).
 */
export type SpotlightTarget =
  | string
  | Element
  | { readonly current: Element | null }
  | { getBoundingClientRect: () => DOMRect }
  | (() => Element | null)
  | null
  | undefined;

export interface SpotlightStep {
  /** What to highlight. See {@link SpotlightTarget}. */
  target: SpotlightTarget;
  /** Already-translated body copy (required). The module never hardcodes copy. */
  body: string;
  /** Already-translated title (optional). */
  title?: string;
  /** Small leading icon, e.g. `<SpotlightEditIcon />`. Rendered in the accent color. */
  icon?: ReactNode;
  /** Card side relative to the target. `'auto'` (default) picks the first side that fits. */
  placement?: SpotlightPlacement;
  /** Bright halo around the target rect, px. Default 8. */
  padding?: number;
  /** Corner radius of the hole/ring, px. Default 12. */
  cornerRadius?: number;
  /**
   * Let pointer events reach the target through the hole (default false: an invisible blocker over
   * the target treats clicks as backdrop clicks). When true, a pointerdown inside the target also
   * advances the tour (unless `backdrop="static"`), so "click the thing we are pointing at"
   * completes the lesson AND the click still lands.
   */
  allowClickThrough?: boolean;
  /** Scroll an offscreen target into view when the step shows. Default true. */
  scrollIntoView?: boolean;
  /** Fired when this step becomes the active one. */
  onShow?: () => void;
}

export interface SpotlightLabels {
  /** Primary button on non-final steps ("Next"). */
  next: string;
  /** Primary button on the final (or only) step ("Got it"). */
  done: string;
  /** Optional Back button label; shown on steps > 0 only when provided. */
  back?: string;
  /** Optional skip link label; shown on non-final steps only when provided. */
  skip?: string;
  /** aria-label for the close (×) button. Falls back to `skip`, then `done`. */
  close?: string;
}

export type SpotlightCloseReason = 'completed' | 'skipped';

export interface SpotlightTourProps {
  /** The tour, in order. A single step is fine. */
  steps: SpotlightStep[];
  labels: SpotlightLabels;
  /**
   * Controlled visibility. When provided, the parent owns showing/hiding (and `storageKey` no
   * longer gates opening). When omitted, the tour auto-opens once per `storageKey` after
   * `openDelayMs`.
   */
  open?: boolean;
  /**
   * localStorage dedupe key (namespaced `kitbash.onboarding.<key>`). With `open` omitted, the tour
   * auto-shows only if the key hasn't been marked seen; it is marked on ANY close (completed or
   * skipped). Use `resetSpotlight(key)` / `force` for a "replay tour" affordance.
   */
  storageKey?: string;
  /** Show even if `storageKey` was already marked seen. Default false. */
  force?: boolean;
  /** Step to open at. Default 0. */
  initialStep?: number;
  /** What clicking the dim (or the blocked target) does. Default `'advance'` (completes on the last step). */
  backdrop?: 'advance' | 'dismiss' | 'static';
  /** Pulse the highlight ring (auto-disabled under prefers-reduced-motion). Default true. */
  pulse?: boolean;
  /** Hole glide duration between steps, ms. Default 260. */
  transitionMs?: number;
  /** Delay before an uncontrolled auto-open, ms (lets the page settle). Default 400. */
  openDelayMs?: number;
  /** Stacking level of the overlay. Default 80. */
  zIndex?: number;
  /** The user finished the last step. */
  onComplete?: () => void;
  /** The user bailed (Esc, ×, skip link, or backdrop-dismiss) at `stepIndex`. */
  onSkip?: (stepIndex: number) => void;
  /** Always fired once on close, after onComplete/onSkip. */
  onClose?: (reason: SpotlightCloseReason) => void;
  /** Fired when the active step changes (not for the initial step). */
  onStepChange?: (stepIndex: number) => void;
}

/** Imperative controls, via `ref` on `<Spotlight />` (this is what `useSpotlight()` proxies). */
export interface SpotlightHandle {
  next: () => void;
  prev: () => void;
  goTo: (stepIndex: number) => void;
  /** Close now. Default reason `'skipped'`. */
  stop: (reason?: SpotlightCloseReason) => void;
  readonly stepIndex: number;
  readonly active: boolean;
}

/* ------------------------------- once-per-user persistence ------------------------------- */

const STORAGE_PREFIX = 'kitbash.onboarding.';
/** In-memory fallback so private-mode/blocked localStorage still dedupes within the session. */
const sessionSeen = new Set<string>();

export function hasSeenSpotlight(storageKey: string): boolean {
  if (sessionSeen.has(storageKey)) return true;
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_PREFIX + storageKey) === '1';
  } catch {
    return false;
  }
}

export function markSpotlightSeen(storageKey: string): void {
  sessionSeen.add(storageKey);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + storageKey, '1');
  } catch {
    /* ignore: the in-memory set already recorded it */
  }
}

export function resetSpotlight(storageKey: string): void {
  sessionSeen.delete(storageKey);
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(STORAGE_PREFIX + storageKey);
  } catch {
    /* ignore */
  }
}

/* ------------------------------------- geometry ------------------------------------- */

type Hole = { x: number; y: number; w: number; h: number; r: number };
type Side = 'top' | 'bottom' | 'left' | 'right' | 'center';

const DEFAULTS = {
  backdrop: 'advance' as const,
  pulse: true,
  transitionMs: 260,
  openDelayMs: 400,
  zIndex: 80,
  padding: 8,
  cornerRadius: 12,
};

/** Minimum breathing room between the card and the viewport edge, px. */
const MARGIN = 12;
/** Gap between the hole and the card, px. */
const GAP = 14;

const fx = (n: number): number => Math.round(n * 100) / 100;
const clampNum = (n: number, min: number, max: number): number => Math.min(Math.max(n, min), Math.max(min, max));
const clampIndex = (i: number, len: number): number => Math.min(Math.max(0, Math.trunc(i)), Math.max(0, len - 1));
const pad2 = (n: number): string => String(n).padStart(2, '0');

function rectSourceOf(target: SpotlightTarget): { getBoundingClientRect: () => DOMRect } | null {
  if (!target || typeof document === 'undefined') return null;
  if (typeof target === 'string') return document.querySelector(target);
  if (typeof target === 'function') return target();
  if (typeof Element !== 'undefined' && target instanceof Element) return target;
  if ('current' in target) return target.current;
  if (typeof target.getBoundingClientRect === 'function') return target;
  return null;
}

/** The concrete DOM element behind a target, when there is one (virtual rects return null). */
function elementOf(target: SpotlightTarget): Element | null {
  const src = rectSourceOf(target);
  return typeof Element !== 'undefined' && src instanceof Element ? src : null;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Full-viewport dim with a rounded hole subtracted (`fill-rule="evenodd"`). Because the hole is
 * genuinely unpainted, pointer events over the target fall through the path to the page.
 */
function overlayPath(vw: number, vh: number, hole: Hole | null): string {
  const outer = `M0 0H${fx(vw)}V${fx(vh)}H0Z`;
  if (!hole) return outer;
  const w = Math.max(0, hole.w);
  const h = Math.max(0, hole.h);
  const r = clampNum(hole.r, 0, Math.min(w, h) / 2);
  return (
    outer +
    `M${fx(hole.x + r)} ${fx(hole.y)}` +
    `h${fx(w - 2 * r)}` +
    `a${fx(r)} ${fx(r)} 0 0 1 ${fx(r)} ${fx(r)}` +
    `v${fx(h - 2 * r)}` +
    `a${fx(r)} ${fx(r)} 0 0 1 ${fx(-r)} ${fx(r)}` +
    `h${fx(-(w - 2 * r))}` +
    `a${fx(r)} ${fx(r)} 0 0 1 ${fx(-r)} ${fx(-r)}` +
    `v${fx(-(h - 2 * r))}` +
    `a${fx(r)} ${fx(r)} 0 0 1 ${fx(r)} ${fx(-r)}` +
    'Z'
  );
}

function approach(cur: Hole, goal: Hole, f: number): Hole {
  return {
    x: cur.x + (goal.x - cur.x) * f,
    y: cur.y + (goal.y - cur.y) * f,
    w: cur.w + (goal.w - cur.w) * f,
    h: cur.h + (goal.h - cur.h) * f,
    r: cur.r + (goal.r - cur.r) * f,
  };
}

function holesClose(a: Hole, b: Hole): boolean {
  return (
    Math.abs(a.x - b.x) < 0.5 &&
    Math.abs(a.y - b.y) < 0.5 &&
    Math.abs(a.w - b.w) < 0.5 &&
    Math.abs(a.h - b.h) < 0.5 &&
    Math.abs(a.r - b.r) < 0.5
  );
}

/** First side with room wins; otherwise the roomiest side, or centered over the target when even
 *  that is cramped (e.g. a full-viewport target leaves no side to stand on). */
function pickAutoSide(hole: Hole, cw: number, ch: number, vw: number, vh: number): Side {
  const space: Record<Exclude<Side, 'center'>, number> = {
    bottom: vh - (hole.y + hole.h) - MARGIN,
    top: hole.y - MARGIN,
    right: vw - (hole.x + hole.w) - MARGIN,
    left: hole.x - MARGIN,
  };
  const order: Array<Exclude<Side, 'center'>> = ['bottom', 'top', 'right', 'left'];
  for (const side of order) {
    const need = (side === 'top' || side === 'bottom' ? ch : cw) + GAP;
    if (space[side] >= need) return side;
  }
  let best: Exclude<Side, 'center'> = 'bottom';
  for (const side of order) if (space[side] > space[best]) best = side;
  return space[best] < 96 ? 'center' : best;
}

function cardPosition(
  side: Side,
  hole: Hole | null,
  cw: number,
  ch: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  let left = (vw - cw) / 2;
  let top = (vh - ch) / 2;
  if (hole && side !== 'center') {
    if (side === 'bottom') {
      left = hole.x + hole.w / 2 - cw / 2;
      top = hole.y + hole.h + GAP;
    } else if (side === 'top') {
      left = hole.x + hole.w / 2 - cw / 2;
      top = hole.y - GAP - ch;
    } else if (side === 'right') {
      left = hole.x + hole.w + GAP;
      top = hole.y + hole.h / 2 - ch / 2;
    } else {
      left = hole.x - GAP - cw;
      top = hole.y + hole.h / 2 - ch / 2;
    }
  }
  return {
    left: clampNum(left, MARGIN, vw - MARGIN - cw),
    top: clampNum(top, MARGIN, vh - MARGIN - ch),
  };
}

/* --------------------------------------- styles --------------------------------------- */

/* Themable via --kb-spot-* custom properties set anywhere above document.body. */
const SPOT_CSS = `
.kb-spot-root {
  position: fixed;
  inset: 0;
  font-family: var(--kb-spot-font, inherit);
}
.kb-spot-veil {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  animation: kb-spot-fade-in 0.2s ease-out both;
}
.kb-spot-veil-path {
  fill: var(--kb-spot-dim-color, rgba(16, 19, 32, 0.45));
}
.kb-spot-ring {
  position: absolute;
  border: 2px solid var(--kb-spot-accent, #4e5ac9);
  animation: kb-spot-ring-in 0.2s ease-out both;
}
.kb-spot-ring--pulse {
  animation: kb-spot-ring-in 0.2s ease-out both, kb-spot-pulse 2.4s ease-in-out 0.25s infinite;
}
.kb-spot-card {
  position: absolute;
  box-sizing: border-box;
  width: 340px;
  max-width: calc(100vw - 24px);
  padding: 16px;
  border: 1px solid var(--kb-spot-border, #e3e5ee);
  border-radius: 12px;
  background: var(--kb-spot-card-bg, #ffffff);
  color: var(--kb-spot-card-fg, #171a24);
  box-shadow: 0 12px 32px rgba(16, 19, 32, 0.18);
  animation: kb-spot-pop-in 0.18s ease-out both;
}
.kb-spot-card * {
  box-sizing: border-box;
}
.kb-spot-caret {
  position: absolute;
  width: 12px;
  height: 12px;
  transform: rotate(45deg);
  background: var(--kb-spot-card-bg, #ffffff);
  border-color: var(--kb-spot-border, #e3e5ee);
}
.kb-spot-close {
  position: absolute;
  top: 12px;
  inset-inline-end: 12px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 4px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--kb-spot-muted, #5c6172);
  cursor: pointer;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.kb-spot-close:hover {
  background: var(--kb-spot-border, #e3e5ee);
  color: var(--kb-spot-card-fg, #171a24);
}
.kb-spot-head {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding-inline-end: 28px;
}
.kb-spot-icon {
  display: inline-flex;
  flex-shrink: 0;
  margin-top: 2px;
  color: var(--kb-spot-accent, #4e5ac9);
}
.kb-spot-text {
  min-width: 0;
  flex: 1;
}
.kb-spot-title {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  line-height: 1.35;
}
.kb-spot-body {
  margin: 0;
  font-size: 13.5px;
  line-height: 1.55;
  color: var(--kb-spot-muted, #5c6172);
}
.kb-spot-title + .kb-spot-body {
  margin-top: 4px;
}
.kb-spot-foot {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--kb-spot-border, #e3e5ee);
}
.kb-spot-count {
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--kb-spot-muted, #5c6172);
}
.kb-spot-spacer {
  flex: 1;
}
.kb-spot-skip {
  padding: 4px 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  font-weight: 500;
  color: var(--kb-spot-muted, #5c6172);
  cursor: pointer;
  transition: color 0.15s ease;
}
.kb-spot-skip:hover {
  color: var(--kb-spot-card-fg, #171a24);
}
.kb-spot-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 6px 14px;
  border: 1px solid transparent;
  border-radius: 8px;
  font-family: inherit;
  font-size: 13px;
  font-weight: 600;
  line-height: 1.4;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, filter 0.15s ease;
}
.kb-spot-btn--primary {
  background: var(--kb-spot-accent, #4e5ac9);
  color: #ffffff;
}
.kb-spot-btn--primary:hover {
  filter: brightness(1.08);
}
.kb-spot-btn--ghost {
  background: transparent;
  color: var(--kb-spot-card-fg, #171a24);
}
.kb-spot-btn--ghost:hover {
  background: var(--kb-spot-border, #e3e5ee);
}
.kb-spot-btn:focus-visible,
.kb-spot-close:focus-visible,
.kb-spot-skip:focus-visible {
  outline: 2px solid var(--kb-spot-accent, #4e5ac9);
  outline-offset: 2px;
}
@keyframes kb-spot-fade-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes kb-spot-pop-in {
  from { opacity: 0; transform: scale(0.96); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes kb-spot-ring-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes kb-spot-pulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--kb-spot-accent, #4e5ac9) 0%, transparent); }
  50% { box-shadow: 0 0 0 6px color-mix(in srgb, var(--kb-spot-accent, #4e5ac9) 18%, transparent); }
}
@keyframes kb-spot-write {
  0% { stroke-dashoffset: 10; }
  45% { stroke-dashoffset: 0; }
  62% { stroke-dashoffset: 0; }
  100% { stroke-dashoffset: -10; }
}
.kb-spot-editline {
  stroke-dasharray: 10 10;
  animation: kb-spot-write 2.2s ease-in-out infinite;
}
@keyframes kb-spot-editnib {
  0% { transform: translateX(-1.5px); }
  45% { transform: translateX(2px); }
  62% { transform: translateX(2px); }
  100% { transform: translateX(-1.5px); }
}
.kb-spot-editnib {
  animation: kb-spot-editnib 2.2s ease-in-out infinite;
}
@media (prefers-reduced-motion: reduce) {
  .kb-spot-veil, .kb-spot-card, .kb-spot-ring, .kb-spot-ring--pulse, .kb-spot-editnib {
    animation: none !important;
  }
  .kb-spot-editline {
    animation: none !important;
    stroke-dasharray: none;
    stroke-dashoffset: 0;
  }
}
@media print {
  .kb-spot-root { display: none !important; }
}
`;

/* ---------------------------------------- icons ---------------------------------------- */

/**
 * A pencil that quietly "writes" its baseline on a loop (static under reduced motion). The
 * animation classes are defined by the Spotlight <style>; outside a spotlight it renders as a
 * static edit icon.
 */
export const SpotlightEditIcon = (p: SVGProps<SVGSVGElement>) => (
  <svg
    width={20}
    height={20}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden
    {...p}
  >
    <g className="kb-spot-editnib">
      <path d="M16.5 3.5a2.121 2.121 0 013 3L7 19l-4 1 1-4L16.5 3.5z" />
    </g>
    <path className="kb-spot-editline" d="M12 20h9" />
  </svg>
);

const CloseGlyph = () => (
  <svg
    width={16}
    height={16}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.7}
    strokeLinecap="round"
    aria-hidden
  >
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

/* -------------------------------------- component -------------------------------------- */

/** useLayoutEffect that stays silent during SSR. */
const useIsoLayoutEffect = typeof window !== 'undefined' ? useLayoutEffect : useEffect;

type Latest = {
  props: SpotlightTourProps;
  visible: boolean;
  index: number;
  step: SpotlightStep | undefined;
};

export const Spotlight = forwardRef<SpotlightHandle, SpotlightTourProps>(function Spotlight(props, ref) {
  const { steps, labels, open } = props;
  const isControlled = open !== undefined;

  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [index, setIndex] = useState(() => clampIndex(props.initialStep ?? 0, steps.length));

  const activeIndex = clampIndex(index, steps.length);
  const step: SpotlightStep | undefined = steps[activeIndex];

  const uid = useId();
  const titleId = `kb-spot-title-${uid}`;
  const bodyId = `kb-spot-body-${uid}`;

  const pathRef = useRef<SVGPathElement | null>(null);
  const ringRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const caretRef = useRef<HTMLSpanElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const aliveRef = useRef(false); // double-close guard (Esc + click racing)
  const indexRef = useRef(index);

  const latest = useRef<Latest>({ props, visible, index: activeIndex, step });

  const eng = useRef<{ raf: number; chasing: boolean; cur: Hole | null; autoSide: Side | null; lastT: number }>({
    raf: 0,
    chasing: false,
    cur: null,
    autoSide: null,
    lastT: 0,
  });

  // Keep the "latest" snapshot fresh at every commit, before the effects below read it.
  useIsoLayoutEffect(() => {
    latest.current = { props, visible, index: activeIndex, step };
    indexRef.current = activeIndex;
  });

  const computeGoal = useCallback((): Hole | null => {
    const st = latest.current.step;
    if (!st) return null;
    const src = rectSourceOf(st.target);
    if (!src) return null;
    const r = src.getBoundingClientRect();
    if (!r || (r.width <= 0 && r.height <= 0)) return null;
    const pad = st.padding ?? DEFAULTS.padding;
    return {
      x: r.left - pad,
      y: r.top - pad,
      w: r.width + pad * 2,
      h: r.height + pad * 2,
      r: st.cornerRadius ?? DEFAULTS.cornerRadius,
    };
  }, []);

  /** Write the current frame straight to the DOM: veil path, ring, card position, caret. */
  const paint = useCallback((vw: number, vh: number, hole: Hole | null) => {
    pathRef.current?.setAttribute('d', overlayPath(vw, vh, hole));

    const ring = ringRef.current;
    if (ring) {
      if (hole) {
        const rr = clampNum(hole.r, 0, Math.min(hole.w, hole.h) / 2);
        ring.style.display = 'block';
        ring.style.left = `${fx(hole.x - 2)}px`;
        ring.style.top = `${fx(hole.y - 2)}px`;
        ring.style.width = `${fx(hole.w + 4)}px`;
        ring.style.height = `${fx(hole.h + 4)}px`;
        ring.style.borderRadius = `${fx(rr + 2)}px`;
      } else {
        ring.style.display = 'none';
      }
    }

    const card = cardRef.current;
    if (!card) return;
    const cw = card.offsetWidth || 340;
    const ch = card.offsetHeight || 160;
    let side: Side = 'center';
    if (hole) {
      const want = latest.current.step?.placement ?? 'auto';
      if (want === 'auto') {
        if (!eng.current.autoSide) eng.current.autoSide = pickAutoSide(hole, cw, ch, vw, vh);
        side = eng.current.autoSide;
      } else {
        side = want;
      }
    }
    const pos = cardPosition(side, hole, cw, ch, vw, vh);
    card.style.left = `${fx(pos.left)}px`;
    card.style.top = `${fx(pos.top)}px`;
    card.style.visibility = 'visible';

    const caret = caretRef.current;
    if (caret) {
      if (!hole || side === 'center') {
        caret.style.display = 'none';
      } else {
        const cx = hole.x + hole.w / 2;
        const cy = hole.y + hole.h / 2;
        caret.style.display = 'block';
        if (side === 'bottom' || side === 'top') {
          caret.style.left = `${fx(clampNum(cx - pos.left - 6, 14, cw - 26))}px`;
          caret.style.top = side === 'bottom' ? '-6.5px' : `${fx(ch - 6.5)}px`;
          caret.style.borderWidth = side === 'bottom' ? '1px 0 0 1px' : '0 1px 1px 0';
        } else {
          caret.style.top = `${fx(clampNum(cy - pos.top - 6, 14, ch - 26))}px`;
          caret.style.left = side === 'right' ? '-6.5px' : `${fx(cw - 6.5)}px`;
          caret.style.borderWidth = side === 'right' ? '0 0 1px 1px' : '1px 1px 0 0';
        }
      }
    }
  }, []);

  const stopChase = useCallback(() => {
    if (eng.current.raf) cancelAnimationFrame(eng.current.raf);
    eng.current.raf = 0;
    eng.current.chasing = false;
  }, []);

  /**
   * Reposition everything. `jump` snaps (scroll/resize tracking must be 1:1); otherwise the hole
   * glides toward the live target rect (staying glued through smooth scrollIntoView because the
   * goal is re-resolved every frame).
   */
  const sync = useCallback(
    (jump: boolean) => {
      if (!latest.current.visible || typeof window === 'undefined') return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const goal = computeGoal();
      const e = eng.current;
      if (jump || !goal || !e.cur || prefersReducedMotion()) {
        stopChase();
        e.cur = goal;
        paint(vw, vh, goal);
        return;
      }
      paint(vw, vh, e.cur); // repaint now so the step's re-render never shows a stale frame
      stopChase();
      e.chasing = true;
      e.lastT = performance.now();
      const tick = (t: number) => {
        const en = eng.current;
        if (!latest.current.visible) {
          stopChase();
          return;
        }
        const w = window.innerWidth;
        const h = window.innerHeight;
        const liveGoal = computeGoal();
        if (!liveGoal || !en.cur) {
          en.cur = liveGoal;
          paint(w, h, liveGoal);
          stopChase();
          return;
        }
        const dt = Math.max(1, t - en.lastT);
        en.lastT = t;
        const ms = Math.max(1, latest.current.props.transitionMs ?? DEFAULTS.transitionMs);
        // Frame-rate-independent exponential ease toward the live goal.
        const f = Math.min(1, 1 - Math.exp((-4 * dt) / ms));
        en.cur = approach(en.cur, liveGoal, f);
        if (holesClose(en.cur, liveGoal)) {
          en.cur = liveGoal;
          paint(w, h, liveGoal);
          stopChase();
          return;
        }
        paint(w, h, en.cur);
        en.raf = requestAnimationFrame(tick);
      };
      e.raf = requestAnimationFrame(tick);
    },
    [computeGoal, paint, stopChase],
  );

  const close = useCallback(
    (reason: SpotlightCloseReason) => {
      if (!aliveRef.current) return;
      aliveRef.current = false;
      const p = latest.current.props;
      if (p.storageKey) markSpotlightSeen(p.storageKey);
      stopChase();
      eng.current.cur = null;
      setVisible(false);
      if (reason === 'completed') p.onComplete?.();
      else p.onSkip?.(indexRef.current);
      p.onClose?.(reason);
      const el = restoreFocusRef.current;
      restoreFocusRef.current = null;
      if (el && typeof document !== 'undefined' && document.contains(el)) el.focus({ preventScroll: true });
    },
    [stopChase],
  );

  const goTo = useCallback((i: number) => {
    const len = latest.current.props.steps.length;
    const next = clampIndex(i, len);
    if (next === indexRef.current) return;
    indexRef.current = next;
    setIndex(next);
    latest.current.props.onStepChange?.(next);
  }, []);

  const advance = useCallback(() => {
    if (indexRef.current >= latest.current.props.steps.length - 1) close('completed');
    else goTo(indexRef.current + 1);
  }, [close, goTo]);

  const prev = useCallback(() => {
    goTo(indexRef.current - 1);
  }, [goTo]);

  const backdropClick = useCallback(() => {
    const mode = latest.current.props.backdrop ?? DEFAULTS.backdrop;
    if (mode === 'advance') advance();
    else if (mode === 'dismiss') close('skipped');
  }, [advance, close]);

  useImperativeHandle(
    ref,
    (): SpotlightHandle => ({
      next: advance,
      prev,
      goTo,
      stop: (reason = 'skipped') => close(reason),
      get stepIndex() {
        return indexRef.current;
      },
      get active() {
        return aliveRef.current;
      },
    }),
    [advance, prev, goTo, close],
  );

  useEffect(() => {
    setMounted(true);
  }, []);

  // Uncontrolled: auto-open once per storageKey, after a settle delay.
  useEffect(() => {
    if (!mounted || isControlled) return;
    const p = latest.current.props;
    if (p.steps.length === 0) return;
    if (p.storageKey && !p.force && hasSeenSpotlight(p.storageKey)) return;
    const id = window.setTimeout(() => setVisible(true), Math.max(0, p.openDelayMs ?? DEFAULTS.openDelayMs));
    return () => window.clearTimeout(id);
  }, [mounted, isControlled]);

  // Controlled: mirror `open`. A parent-forced close is reported as a skip so callbacks stay consistent.
  useEffect(() => {
    if (!isControlled) return;
    if (open) {
      const p = latest.current.props;
      const i = clampIndex(p.initialStep ?? 0, p.steps.length);
      indexRef.current = i;
      setIndex(i);
      if (p.steps.length > 0) setVisible(true);
    } else if (aliveRef.current) {
      close('skipped');
    }
  }, [isControlled, open, close]);

  // Arm the close guard + remember where focus was, to restore it after the tour.
  useEffect(() => {
    if (!visible) return;
    aliveRef.current = true;
    const ae = typeof document !== 'undefined' ? document.activeElement : null;
    restoreFocusRef.current = ae instanceof HTMLElement ? ae : null;
  }, [visible]);

  // Per step: onShow, bring the target into view, position (pre-paint), focus the primary button.
  useIsoLayoutEffect(() => {
    if (!mounted || !visible) return;
    eng.current.autoSide = null;
    const st = latest.current.step;
    st?.onShow?.();
    const el = elementOf(st?.target);
    if (el && st?.scrollIntoView !== false) {
      // A target taller than the viewport aligns to its TOP so its beginning is visible;
      // everything else centers.
      const tall = el.getBoundingClientRect().height > window.innerHeight - 40;
      el.scrollIntoView({
        block: tall ? 'start' : 'center',
        inline: 'nearest',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth',
      });
    }
    sync(false);
    // Some browsers fire no scroll events for a programmatic smooth scroll, so re-sync after it.
    const t1 = window.setTimeout(() => sync(false), 240);
    const t2 = window.setTimeout(() => sync(false), 520);
    const raf = requestAnimationFrame(() => primaryRef.current?.focus({ preventScroll: true }));
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t1);
      window.clearTimeout(t2);
    };
  }, [mounted, visible, activeIndex]);

  // While open: track scroll/resize (rAF-coalesced), poll as a safety net (late-mounting targets,
  // silent layout shifts), Esc to skip, a light Tab trap, and click-through advancement.
  useEffect(() => {
    if (!mounted || !visible) return;

    let scheduled = 0;
    const schedule = () => {
      if (eng.current.chasing || scheduled) return;
      scheduled = requestAnimationFrame(() => {
        scheduled = 0;
        sync(true);
      });
    };
    const onScroll = () => schedule();
    const onResize = () => {
      eng.current.autoSide = null;
      schedule();
    };
    window.addEventListener('scroll', onScroll, { capture: true, passive: true });
    window.addEventListener('resize', onResize);
    const poll = window.setInterval(() => {
      if (!eng.current.chasing) sync(true);
    }, 250);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        close('skipped');
        return;
      }
      if (e.key !== 'Tab') return;
      if (latest.current.step?.allowClickThrough) return; // page must stay keyboard-usable too
      const card = cardRef.current;
      if (!card) return;
      const focusables = Array.from(
        card.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((f) => !f.hasAttribute('disabled'));
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) return;
      const active = document.activeElement;
      const inside = active instanceof Node && card.contains(active);
      if (e.shiftKey && (!inside || active === first)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (!inside || active === last)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);

    // Click-through steps: the tour advances AND the click still lands (no preventDefault).
    const onPointerDown = (e: PointerEvent) => {
      const st = latest.current.step;
      if (!st?.allowClickThrough) return;
      if ((latest.current.props.backdrop ?? DEFAULTS.backdrop) === 'static') return;
      const el = elementOf(st.target);
      if (el && e.target instanceof Node && el.contains(e.target)) advance();
    };
    document.addEventListener('pointerdown', onPointerDown, true);

    return () => {
      if (scheduled) cancelAnimationFrame(scheduled);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
      window.clearInterval(poll);
      document.removeEventListener('keydown', onKeyDown, true);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [mounted, visible, sync, close, advance]);

  // Track target size changes tightly (e.g. content grows while the user types into it).
  useEffect(() => {
    if (!mounted || !visible || typeof ResizeObserver === 'undefined') return;
    const el = elementOf(latest.current.step?.target);
    if (!el) return;
    const ro = new ResizeObserver(() => {
      if (!eng.current.chasing) sync(true);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted, visible, activeIndex, sync]);

  // Unmount: kill any in-flight frame.
  useEffect(() => () => stopChase(), [stopChase]);

  if (!mounted || !visible || !step) return null;

  const total = steps.length;
  const isLast = activeIndex >= total - 1;
  const multi = total > 1;
  const clickThrough = step.allowClickThrough === true;
  const interactiveBackdrop = (props.backdrop ?? DEFAULTS.backdrop) !== 'static';
  const pulse = props.pulse ?? DEFAULTS.pulse;

  return createPortal(
    <div
      className="kb-spot-root"
      style={{ zIndex: props.zIndex ?? DEFAULTS.zIndex, pointerEvents: 'none' }}
      aria-live="polite"
      data-kb-spotlight=""
    >
      <style>{SPOT_CSS}</style>

      <svg className="kb-spot-veil" style={{ pointerEvents: 'none' }} aria-hidden="true">
        <path
          ref={pathRef}
          className="kb-spot-veil-path"
          fillRule="evenodd"
          style={{ pointerEvents: 'auto', cursor: interactiveBackdrop ? 'pointer' : 'default' }}
          onClick={backdropClick}
        />
      </svg>

      <div
        ref={ringRef}
        aria-hidden="true"
        onClick={clickThrough ? undefined : backdropClick}
        className={pulse ? 'kb-spot-ring kb-spot-ring--pulse' : 'kb-spot-ring'}
        style={{
          display: 'none',
          pointerEvents: clickThrough ? 'none' : 'auto',
          cursor: !clickThrough && interactiveBackdrop ? 'pointer' : 'default',
        }}
      />

      <div
        key={activeIndex}
        ref={cardRef}
        role="dialog"
        aria-labelledby={step.title ? titleId : bodyId}
        aria-describedby={bodyId}
        className="kb-spot-card"
        style={{ pointerEvents: 'auto', visibility: 'hidden' }}
      >
        <span
          ref={caretRef}
          aria-hidden="true"
          className="kb-spot-caret"
          style={{ display: 'none', borderStyle: 'solid', borderWidth: 0 }}
        />

        <button
          type="button"
          onClick={() => close('skipped')}
          aria-label={labels.close ?? labels.skip ?? labels.done}
          className="kb-spot-close"
        >
          <CloseGlyph />
        </button>

        <div className="kb-spot-head">
          {step.icon ? (
            <span className="kb-spot-icon" aria-hidden="true">
              {step.icon}
            </span>
          ) : null}
          <div className="kb-spot-text">
            {step.title ? (
              <h3 id={titleId} className="kb-spot-title">
                {step.title}
              </h3>
            ) : null}
            <p id={bodyId} className="kb-spot-body">
              {step.body}
            </p>
          </div>
        </div>

        <div className="kb-spot-foot">
          {multi ? (
            <span className="kb-spot-count">
              {pad2(activeIndex + 1)} / {pad2(total)}
            </span>
          ) : null}
          <span className="kb-spot-spacer" aria-hidden="true" />
          {labels.skip && !isLast ? (
            <button type="button" onClick={() => close('skipped')} className="kb-spot-skip">
              {labels.skip}
            </button>
          ) : null}
          {labels.back && activeIndex > 0 ? (
            <button type="button" onClick={prev} className="kb-spot-btn kb-spot-btn--ghost">
              {labels.back}
            </button>
          ) : null}
          <button ref={primaryRef} type="button" onClick={advance} className="kb-spot-btn kb-spot-btn--primary">
            {isLast ? labels.done : labels.next}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
});

/* ----------------------------------------- hook ----------------------------------------- */

export type SpotlightHookDefaults = Omit<SpotlightTourProps, 'steps' | 'open'>;
export type SpotlightStartOverrides = Partial<SpotlightHookDefaults>;

export interface SpotlightController {
  /** Begin a tour. No-ops if `storageKey` (defaults or overrides) was already marked seen and not forced. */
  start: (steps: SpotlightStep[], overrides?: SpotlightStartOverrides) => void;
  /** Close the running tour (reported as a skip). */
  stop: () => void;
  next: () => void;
  prev: () => void;
  goTo: (stepIndex: number) => void;
  active: boolean;
  /** Render this once, anywhere in your JSX: `{tour.element}`. */
  element: ReactNode;
}

/**
 * Thin imperative wrapper around `<Spotlight />` for "start a tour from an event handler" call
 * sites; proxies next/prev/goTo through its handle. Restarting while active resets to step 0.
 */
export function useSpotlight(defaults: SpotlightHookDefaults): SpotlightController {
  const handleRef = useRef<SpotlightHandle | null>(null);
  const defaultsRef = useRef(defaults);
  defaultsRef.current = defaults;
  const [session, setSession] = useState<{
    steps: SpotlightStep[];
    overrides?: SpotlightStartOverrides;
    nonce: number;
  } | null>(null);

  const start = useCallback((steps: SpotlightStep[], overrides?: SpotlightStartOverrides) => {
    if (steps.length === 0) return;
    const key = overrides?.storageKey ?? defaultsRef.current.storageKey;
    const force = overrides?.force ?? defaultsRef.current.force ?? false;
    if (key && !force && hasSeenSpotlight(key)) return;
    setSession((s) => ({ steps, overrides, nonce: (s?.nonce ?? 0) + 1 }));
  }, []);

  const stop = useCallback(() => {
    if (handleRef.current?.active) handleRef.current.stop('skipped');
    else setSession(null);
  }, []);

  const next = useCallback(() => {
    handleRef.current?.next();
  }, []);
  const prev = useCallback(() => {
    handleRef.current?.prev();
  }, []);
  const goTo = useCallback((i: number) => {
    handleRef.current?.goTo(i);
  }, []);

  let element: ReactNode = null;
  if (session) {
    const merged = { ...defaultsRef.current, ...session.overrides };
    const userClose = merged.onClose;
    element = (
      <Spotlight
        key={session.nonce}
        ref={handleRef}
        open
        steps={session.steps}
        {...merged}
        onClose={(reason) => {
          userClose?.(reason);
          setSession(null);
        }}
      />
    );
  }

  return { start, stop, next, prev, goTo, active: session !== null, element };
}
