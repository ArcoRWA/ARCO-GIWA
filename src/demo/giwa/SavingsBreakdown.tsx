// What the Savings rows under the card show: the Backing bar (its row's preview), the Backing breakdown by manager or
// by asset type, and the instant liquidity with the coins it is held in. The bar and the tiles point at the same slice
// (by its id): the page holds which slice each points at and hands it to the other.

import { useEffect, useRef, useState, type CSSProperties } from "react"
import { BrandMark } from "../components/BrandMark"
import { AllocationTiles, TILE_HATCH } from "./AllocationTreemap"
import { SavingsInfoTip } from "./SavingsInfoTip"
import type { AllocationSlice } from "./savings-backing"
import type { SavingsHeroTone } from "./SavingsHeroCard"
import { pctLabel } from "./TwoMetricChartCard"

// The bar's colours, largest slice first and darkest first; the tone re-scopes them (theme.css, data-savings-bar-tone).
const BAR_COLORS = [
  "bg-[var(--color-savings-bar-1)]",
  "bg-[var(--color-savings-bar-2)]",
  "bg-[var(--color-savings-bar-3)]",
  "bg-[var(--color-savings-bar-4)]",
  "bg-[var(--color-savings-bar-5)]",
] as const

/** The slices largest first (ties keep their order), as the bar and its legend show them. */
export function barOrder(slices: readonly AllocationSlice[]): AllocationSlice[] {
  return slices
    .map((slice, index) => ({ slice, index }))
    .sort((a, b) => b.slice.percent - a.slice.percent || a.index - b.index)
    .map(({ slice }) => slice)
}

// Whether a focused element shows its focus (keyboard focus, not a tap or a click); true where the browser cannot say.
function focusVisible(element: Element): boolean {
  try {
    return element.matches(":focus-visible")
  } catch {
    return true
  }
}

/**
 * One bar of the backing's slices, sized by share, with a legend of each slice and its share (from `sm` up). Each slice
 * is a button named by its label and share. Pointed at (a mouse) or focused from the keyboard, it grows a little, the
 * other slices and legend items fade and a tip over it names it (from `sm` up). Tapped or pressed, it stays picked
 * (pressed again, it lets go): on phones a line under the bar names it (no line while nothing is picked). Escape lets go.
 * `highlight` is a slice pointed at elsewhere (its Backing tile), emphasised the same way without the tip;
 * `onHighlight` hears the slice the bar points at (pointed at, focused, else picked), or null.
 */
export function BackingBar({
  slices,
  tone,
  highlight = null,
  onHighlight,
}: {
  slices: readonly AllocationSlice[]
  tone: SavingsHeroTone
  highlight?: string | null
  onHighlight?: (sliceId: string | null) => void
}) {
  const ordered = barOrder(slices)
  const [hovered, setHovered] = useState<string | null>(null)
  const [focused, setFocused] = useState<string | null>(null)
  const [picked, setPicked] = useState<string | null>(null)
  const pointing = hovered ?? focused
  const own = pointing ?? picked
  const shown = pointing ?? highlight ?? picked

  const report = useRef(onHighlight)
  report.current = onHighlight
  useEffect(() => report.current?.(own), [own])
  useEffect(() => () => report.current?.(null), [])
  useEffect(() => {
    if (own === null) return
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return
      setHovered(null)
      setFocused(null)
      setPicked(null)
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [own])

  const pickedIndex = ordered.findIndex((slice) => slice.id === picked)
  const pickedSlice = pickedIndex >= 0 ? ordered[pickedIndex] : undefined
  const last = ordered.length - 1
  return (
    <div data-savings-bar-tone={tone} className="flex w-full flex-col gap-2.5">
      <div className="flex h-3 w-full gap-0.5">
        {ordered.map((slice, index) => {
          const color = BAR_COLORS[index % BAR_COLORS.length]
          const emphasised = shown === slice.id
          const faded = shown !== null && !emphasised
          return (
            <button
              key={slice.id}
              type="button"
              data-bar-slice={slice.id}
              data-emphasis={emphasised ? "on" : faded ? "faded" : undefined}
              aria-label={`${slice.label} ${pctLabel(slice.percent)}`}
              aria-pressed={picked === slice.id}
              onPointerEnter={(event) => {
                if (event.pointerType === "mouse") setHovered(slice.id)
              }}
              onPointerLeave={(event) => {
                if (event.pointerType === "mouse") setHovered((current) => (current === slice.id ? null : current))
              }}
              onFocus={(event) => {
                if (focusVisible(event.currentTarget)) setFocused(slice.id)
              }}
              onBlur={() => setFocused((current) => (current === slice.id ? null : current))}
              onClick={() => setPicked((current) => (current === slice.id ? null : slice.id))}
              // 12px of extra tap target above and below (::before); the bar itself stays 12px tall.
              className={`pointer-events-auto relative min-w-0 basis-0 cursor-pointer transition-opacity duration-150 before:absolute before:inset-x-0 before:-inset-y-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] motion-reduce:transition-none ${
                index === 0 ? "rounded-l-[2px]" : ""
              } ${index === last ? "rounded-r-[2px]" : ""} ${faded ? "opacity-[0.28]" : ""}`}
              style={{ flexGrow: slice.percent }}
            >
              <span
                aria-hidden="true"
                className={`absolute inset-0 rounded-[inherit] ${color} transition-transform duration-150 motion-reduce:transition-none ${
                  emphasised ? "scale-y-150 motion-reduce:scale-y-100" : ""
                }`}
              />
              {pointing === slice.id && (
                // Over the slice, kept inside the row at either end.
                <span
                  aria-hidden="true"
                  data-bar-tip={slice.id}
                  className={`pointer-events-none absolute bottom-[calc(100%+10px)] z-20 hidden items-center gap-2 whitespace-nowrap rounded-[10px] bg-[var(--color-arco-ink)] px-[11px] py-[7px] text-[12.5px] font-medium leading-4 text-[var(--color-savings-tip-text)] sm:flex ${
                    index === 0 ? "left-0" : index === last ? "right-0" : "left-1/2 -translate-x-1/2"
                  }`}
                >
                  <span className={`size-[9px] shrink-0 rounded-[2px] ring-1 ring-[color:var(--color-arco-muted)] ${color}`} />
                  {slice.label}
                  <span className="tabular-nums opacity-75">{pctLabel(slice.percent)}</span>
                </span>
              )}
            </button>
          )
        })}
      </div>
      {/* The slices' buttons carry the names, so the legend, the tip and the phone line are not read again. */}
      <div aria-hidden="true" className="hidden flex-wrap gap-x-[18px] gap-y-1.5 text-[13px] text-[var(--color-arco-ink)] sm:flex">
        {ordered.map((slice, index) => (
          <span
            key={slice.id}
            data-legend-slice={slice.id}
            className={`inline-flex items-center gap-1.5 transition-opacity duration-150 motion-reduce:transition-none ${
              shown !== null && shown !== slice.id ? "opacity-40" : ""
            }`}
          >
            <span className={`size-2.5 shrink-0 ${BAR_COLORS[index % BAR_COLORS.length]}`} />
            {slice.label} {pctLabel(slice.percent)}
          </span>
        ))}
      </div>
      {pickedSlice !== undefined && (
        <div aria-hidden="true" data-bar-caption={pickedSlice.id} className="flex min-w-0 items-center gap-2 text-[13px] leading-5 sm:hidden">
          <span className={`size-2.5 shrink-0 ${BAR_COLORS[pickedIndex % BAR_COLORS.length]}`} />
          <span className="min-w-0 truncate font-medium text-[var(--color-arco-ink)]">{pickedSlice.label}</span>
          <span className="shrink-0 tabular-nums text-[var(--color-arco-text-soft)]">{pctLabel(pickedSlice.percent)}</span>
        </div>
      )}
    </div>
  )
}

type BackingView = "manager" | "asset"

const VIEWS: readonly Readonly<{ id: BackingView; label: string }>[] = [
  { id: "manager", label: "By manager" },
  { id: "asset", label: "By asset type" },
]

/**
 * The Backing row's content: "By manager" (the managers' tiles, each opening its card) or "By asset type" (the same
 * backing grouped by the kind of asset it is held in), picked with a pill toggle.
 */
export function BackingBreakdown({
  backing,
  exposure,
  totalUsd,
  highlight = null,
  onHighlight,
}: {
  backing: readonly AllocationSlice[]
  exposure: readonly AllocationSlice[]
  /** The backing in dollars (the TVL), for each manager tile's value in its card; null while unknown. */
  totalUsd: number | null
  /** The slice the Backing bar points at: its tile (if the view shows one by that id) is highlighted. */
  highlight?: string | null
  /** Hears the slice whose tile is pointed at or focused, or null. */
  onHighlight?: (sliceId: string | null) => void
}) {
  const [view, setView] = useState<BackingView>("manager")
  const shown =
    view === "manager"
      ? {
          slices: backing,
          title: "Backing assets",
          info: "What stands behind every share: funds from Fidelity, UBS and Franklin Templeton, a loan book and an instant liquidity reserve.",
        }
      : { slices: exposure, title: "Exposure by asset type", info: "The same backing grouped by the kind of asset it is held in." }
  return (
    <div className="w-full">
      <div className="flex items-center gap-2 sm:gap-3">
        <div role="group" aria-label="Backing" className="grid flex-1 grid-cols-2 gap-1.5 sm:flex sm:flex-none">
          {VIEWS.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={view === option.id}
              onClick={() => setView(option.id)}
              className={`min-h-11 whitespace-nowrap rounded-[var(--radius-pill)] border px-2 text-[13px] font-medium transition-colors duration-150 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)] motion-reduce:transition-none sm:min-h-9 sm:px-3.5 ${
                view === option.id
                  ? "border-[var(--color-arco-ink)] bg-[var(--color-arco-ink)] text-[var(--color-arco-on-dark)]"
                  : "border-[var(--color-arco-border)] bg-[var(--color-arco-surface)] text-[var(--color-arco-text-soft)] hover:text-[var(--color-arco-ink)]"
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="ml-auto inline-flex">
          <SavingsInfoTip label={`About ${shown.title.toLowerCase()}`} text={shown.info} align="end" />
        </span>
      </div>
      <div className="mt-4">
        {/* Keyed by view so a card left open on one view never shows over the other. */}
        <AllocationTiles
          key={view}
          slices={shown.slices}
          label={shown.title}
          totalUsd={view === "manager" ? totalUsd : null}
          highlight={highlight}
          onHighlight={onHighlight}
        />
      </div>
    </div>
  )
}

/** A coin's tile: its mark and name at the top, its share of the instant liquidity at the bottom right. */
function LiquidityTile({ slice, style }: { slice: AllocationSlice; style?: CSSProperties }) {
  return (
    <li
      className="flex min-w-0 flex-col justify-between gap-1 overflow-hidden rounded-[12px] bg-[var(--color-arco-page)] p-2.5 sm:p-3"
      style={{ ...TILE_HATCH, ...style }}
    >
      <span className="flex min-w-0 items-center gap-1.5 text-xs font-medium leading-4 text-[var(--color-arco-ink)] sm:text-[13px]">
        {slice.logo !== null && <BrandMark src={slice.logo} label={slice.label} size={16} className="bg-[var(--color-arco-surface)]" />}
        <span className="truncate">{slice.label}</span>
      </span>
      <span className="self-end text-xs tabular-nums text-[var(--color-arco-text-soft)]">{pctLabel(slice.percent)}</span>
    </li>
  )
}

/**
 * The Liquidity row's content: the instant liquidity in dollars, then the coins it is held in: the largest coin across
 * the top, the others side by side under it, each as wide as its share (never too narrow for its name).
 */
export function LiquidityBreakdown({ amountText, slices }: { amountText: string; slices: readonly AllocationSlice[] }) {
  const [first, ...rest] = [...slices].sort((a, b) => b.percent - a.percent)
  return (
    <div className="w-full">
      <p className="text-[13px] text-[var(--color-arco-text-soft)]">Instant liquidity</p>
      <p className="mt-1 text-[28px] font-medium leading-9 tabular-nums text-[var(--color-arco-ink)] sm:text-[32px] sm:leading-10">{amountText}</p>
      {first !== undefined && (
        <ul
          aria-label="Instant liquidity"
          className={`mt-4 grid w-full gap-1.5 ${rest.length > 0 ? "h-[200px] grid-rows-[3fr_minmax(56px,1fr)]" : "h-[120px]"}`}
          // The coins under the largest: each column as wide as its share, at least 88px.
          style={rest.length > 0 ? { gridTemplateColumns: rest.map((slice) => `minmax(88px, ${slice.percent}fr)`).join(" ") } : undefined}
        >
          <LiquidityTile slice={first} style={{ gridColumn: "1 / -1" }} />
          {rest.map((slice) => (
            <LiquidityTile key={slice.id} slice={slice} />
          ))}
        </ul>
      )}
    </div>
  )
}
