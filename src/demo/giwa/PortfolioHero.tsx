// The Portfolio's navy card (look "A"): the wallet's current value of its Savings and Funds, ticking up live at the
// Net APY, what was supplied under it, and Lifetime Earned / Net APY in two glass panels. It is the Savings card's look
// (SavingsHeroCard.tsx: the navy gradient, the aurora, the orbits, theme.css's liquid glass), not a copy of it.

import { useEffect, useState } from "react"
import { HERO_BACKGROUND, HeroAurora, HeroOrbits } from "./SavingsHeroCard"
import { RollingDigits, useTrend } from "./RollingDigits"
import { accruedValue, canGrow } from "./portfolio-projection"
import { balanceParts } from "./savings-format"
import { money } from "../lib/format"

const ON_HERO_MUTED = "text-[var(--color-savings-on-hero-muted)]"
const EARNING = "text-[var(--color-savings-hero-earning)]"
const TICK_MS = 250

function reducedMotionQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia("(prefers-reduced-motion: reduce)") : null
}

/** Whether the user prefers reduced motion, following changes to the setting. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false)
  useEffect(() => {
    const query = reducedMotionQuery()
    if (!query) return
    const update = () => setReduced(query.matches)
    update()
    query.addEventListener?.("change", update)
    return () => query.removeEventListener?.("change", update)
  }, [])
  return reduced
}

/**
 * The big number. While it can grow (a known value and a Net APY above zero, motion allowed) it shows the cents and
 * three smaller, dimmer digits after them that tick up a few times a second: the last confirmed value compounding at
 * the Net APY since it was read (an on-screen estimate, re-anchored whenever the data refreshes). It owns its timer, so
 * only this number re-renders; the timer stops while the tab is hidden. Otherwise: the plain value with its cents.
 * Screen readers get the one confirmed value; the ticking digits are hidden from them.
 */
export function LiveCurrentValue({ value, earningUsd, apyPercent }: { value: number | null; earningUsd: number; apyPercent: number | null }) {
  const reduced = usePrefersReducedMotion()
  const live = !reduced && value !== null && canGrow(value, apyPercent) && earningUsd > 0
  const [anchor, setAnchor] = useState(() => ({ value, apyPercent, earningUsd, at: Date.now() }))
  if (anchor.value !== value || anchor.apyPercent !== apyPercent || anchor.earningUsd !== earningUsd) {
    setAnchor({ value, apyPercent, earningUsd, at: Date.now() })
  }
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!live) return
    let timer: number | undefined
    const start = () => {
      if (timer === undefined) timer = window.setInterval(() => setNow(Date.now()), TICK_MS)
    }
    const stop = () => {
      if (timer !== undefined) window.clearInterval(timer)
      timer = undefined
    }
    const onVisibility = () => {
      if (document.hidden) stop()
      else {
        setNow(Date.now())
        start()
      }
    }
    if (!document.hidden) start()
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      stop()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [live])
  const shown = live ? accruedValue({ value: value as number, earningUsd, apyPercent: apyPercent as number, elapsedMs: now - anchor.at }) : value
  const trend = useTrend(shown)
  // A hair above the value before the digits are cut, so binary rounding (12412.36 × 1e5 = 1241235999.99…) never shows
  // "$12,412.35" + "999" for an exact $12,412.36.
  const parts = live && shown !== null ? balanceParts(shown + Math.max(1e-8, Math.abs(shown) * 1e-14)) : null
  return (
    <p data-testid="portfolio-current-value" className="whitespace-nowrap font-medium leading-none tracking-[-0.03em] tabular-nums text-[clamp(28px,10vw,38px)] md:text-[52px] lg:text-[60px]">
      <span className="sr-only">{value !== null ? money(value) : "Current value unavailable"}</span>
      {parts !== null ? (
        <span aria-hidden="true">
          <RollingDigits text={`${parts.whole}${parts.cents}`} trend={trend} />
          <span data-ticker-digits="" className={`ml-px text-[0.5em] tracking-normal ${ON_HERO_MUTED}`}>
            <RollingDigits text={parts.tail} trend={trend} />
          </span>
        </span>
      ) : (
        <span aria-hidden="true">{value !== null ? money(value) : "—"}</span>
      )}
    </p>
  )
}

export type PortfolioHeroProps = {
  /** Current value of the Savings and Funds holdings in USD; null while unknown. */
  value: number | null
  /** The part of `value` in holdings that earn the Net APY. */
  earningUsd: number
  apyPercent: number | null
  /** Formatted figures, "—" while unknown. */
  supplied: string
  earned: string
  apy: string
  /** Small notes under Supplied ("Partial — …"). */
  notes: readonly string[]
}

export function PortfolioHero({ value, earningUsd, apyPercent, supplied, earned, apy, notes }: PortfolioHeroProps) {
  return (
    <section
      aria-label="Current value"
      className="relative isolate w-full overflow-hidden rounded-[22px] text-[var(--color-arco-on-dark)]"
      style={HERO_BACKGROUND}
    >
      <HeroAurora />
      <div className="relative">
        <HeroOrbits layout="portfolio" />
        <div className="flex flex-col gap-[18px] px-5 py-[22px] md:flex-row md:items-end md:justify-between md:gap-5 md:px-8 md:py-[30px]">
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="flex items-center gap-2.5 text-lg font-medium">
              Current value
              {value !== null && value > 0 && (
                <span className={`inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] bg-[var(--color-savings-on-hero-fill)] px-2 py-0.5 text-xs ${EARNING} ring-1 ring-[var(--color-savings-on-hero-line)]`}>
                  <span aria-hidden="true" className="relative inline-flex size-1.5 shrink-0">
                    <span className="savings-heartbeat-halo absolute inset-0 rounded-[var(--radius-pill)] bg-[var(--color-savings-hero-earning)]" />
                    <span className="savings-heartbeat-dot relative size-1.5 rounded-[var(--radius-pill)] bg-[var(--color-savings-hero-earning)]" />
                  </span>
                  Live
                </span>
              )}
            </p>
            <LiveCurrentValue value={value} earningUsd={earningUsd} apyPercent={apyPercent} />
            <p data-testid="portfolio-supplied" className={`mt-1.5 text-sm tabular-nums ${ON_HERO_MUTED}`}>
              Supplied <span className="font-medium text-[var(--color-arco-on-dark)]">{supplied}</span>
            </p>
            {notes.map((note) => (
              <p key={note} className={`text-[11px] ${ON_HERO_MUTED}`}>{note}</p>
            ))}
          </div>
          <div className="flex gap-2.5">
            <HeroStat label="Lifetime Earned" value={earned} testId="portfolio-earned" />
            <HeroStat label="Net APY" value={apy} testId="portfolio-net-apy" />
          </div>
        </div>
      </div>
    </section>
  )
}

function HeroStat({ label, value, testId }: { label: string; value: string; testId: string }) {
  return (
    <div className="savings-glass flex min-w-0 flex-1 flex-col gap-1.5 rounded-[20px] px-3.5 py-3 md:min-w-[136px] md:flex-none md:px-[18px] md:py-3.5">
      <span className={`text-[12.5px] ${ON_HERO_MUTED}`}>{label}</span>
      <span data-testid={testId} className={`text-lg font-medium tabular-nums md:text-[22px] ${value === "—" ? "" : EARNING}`}>{value}</span>
    </div>
  )
}
