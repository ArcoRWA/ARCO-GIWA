// "Your potential earnings" (Portfolio): a line of the projected balance from today to 3, 5 or 10 years out (3 years
// first). Interest is a few percent of the balance a year, so the vertical axis does not start at zero: it starts a
// little below what was supplied (portfolio-chart-axis.ts), so the line visibly rises. No y labels or horizontal
// gridlines; faint vertical gridlines mark Today and every year.
//
// A scrubber rides the line: a round handle with a translucent band, at rest on the range's end. Pointing at the plot
// (hover, press-and-drag, a tap, or the keyboard) moves it to the nearest month, and the header follows it: the left slot
// names the month, the projected balance there and its interest; the right slot the what-if there.
//
// When the wallet holds coins that earn nothing (the "Not earning" group, portfolio-idle.ts) that a Savings account with
// a known rate takes, a dashed green line adds the interest they would earn there, with a call to move them; the gap
// between it and the line is filled with a light, translucent green. When that what-if dwarfs the projection, the gap is
// drawn closer than its true scale (plotLayout in portfolio-chart-axis.ts) so both lines stay readable.

import { useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject } from "react"
import { Link } from "react-router-dom"
import { CircleHelp } from "lucide-react"
import { PROJECTION_RANGES, projectMonths, whatIfOf, type IdleEarning, type ProjectionBar, type ProjectionRange, type WhatIf } from "./portfolio-projection"
import { plotLayout, yearGridMonths, yearTicks, type PlotLayout } from "./portfolio-chart-axis"
import { GIWA_SAVINGS_ROUTE } from "./routes"
import { money } from "../lib/format"

const SEGMENT_ACTIVE = "bg-[var(--color-arco-surface)] font-medium text-[var(--color-arco-ink)] shadow-[var(--shadow-control)]"
const SEGMENT_IDLE = "text-[var(--color-arco-muted-text)]"

const pctText = (n: number) => `${Number(n.toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`
const plus = (n: number) => `+${money(n)}`

// The card's words, one constant each (the what-if copy is provisional).
const TITLE = "Your potential earnings"
const NO_RATE = "Potential earnings show once your holdings have a current APY."
const TODAY_LABEL = "Today · Current value"
const interestNote = (n: number) => `${plus(n)} interest`
const LEGEND_LINE = "Projected balance"
const WHAT_IF_TITLE = "With idle assets in Savings"
const whatIfMore = (n: number) => `${plus(n)} more interest`
const CTA_IDLE = " is not earning."
const CTA_BUTTON = "Move to Savings →"
const TIP_LABEL = "About this estimate"
const tipText = (netApyPercent: number) =>
  `Estimate only, at today's ${pctText(netApyPercent)} Net APY with nothing added or withdrawn. Rates change; returns are not guaranteed. The vertical axis starts near what you supplied, not at zero.`
const TIP_WHAT_IF = "The dashed line adds the interest your idle assets would earn at today's Savings rates; it is not a promise."

/** Whether an element's focus came from the keyboard (:focus-visible); true where the browser cannot tell. */
function isKeyboardFocus(element: Element): boolean {
  try {
    return element.matches(":focus-visible")
  } catch {
    return true
  }
}

export type PortfolioEarningsChartProps = {
  /** Current value in USD; null while unknown. */
  value: number | null
  /** The part of `value` that earns; the rest (holdings without a rate) is carried flat. */
  earningUsd: number
  /** The earning part's rate, which the projection grows it at. */
  apyPercent: number | null
  /** The page's Net APY (the same interest over the whole value), named in the "?" tip. */
  netApyPercent: number | null
  /** Lifetime earned and supplied in USD; null when unknown (the axis then starts near today's value). */
  earned: number | null
  supplied: number | null
  /** The wallet's idle coins in USD with the rate each would earn in Savings: the what-if line when they apply. */
  idleAssets?: readonly IdleEarning[] | null
  /** Shown in place of the chart (loading, no holdings, no rate). */
  emptyLabel: string | null
  today: Date
}

export function PortfolioEarningsChart({
  value, earningUsd, apyPercent, netApyPercent, earned, supplied, idleAssets = null, emptyLabel, today,
}: PortfolioEarningsChartProps) {
  const [range, setRange] = useState<ProjectionRange>(PROJECTION_RANGES[0].id)
  // The month the scrubber points at (hover, drag, tap or keyboard); null at rest (the handle on the range's end).
  const [active, setActive] = useState<number | null>(null)
  const months = emptyLabel === null ? projectMonths({ value, earningUsd, apyPercent, range, today }) : []
  const whatIf = months.length > 0 ? whatIfOf(idleAssets) : null
  const whatIfMonths = whatIf ? projectMonths({ value, earningUsd, apyPercent, range, today, whatIf }) : null
  const message = emptyLabel ?? (months.length === 0 ? NO_RATE : null)
  const principal = earned !== null && supplied !== null ? { earned, supplied } : null
  const first = months[0]
  const last = months[months.length - 1]
  const whatIfLast = whatIfMonths?.[whatIfMonths.length - 1]
  // Where the lines sit in the plot; the what-if gap compressed when it dwarfs the projection.
  const layout = first ? plotLayout(principal?.supplied ?? first.value, months.map((p) => p.value), whatIfMonths?.map((p) => p.value) ?? null) : null
  const point = active !== null ? months[active] : undefined
  const whatIfPoint = active !== null ? whatIfMonths?.[active] : whatIfLast
  const shownPoint = point ?? last
  return (
    <section aria-labelledby="portfolio-earnings-title" className="w-full rounded-[22px] bg-[var(--color-arco-surface)] p-[18px] md:p-6" style={{ boxShadow: "var(--shadow-control)" }}>
      <div className="relative mb-3.5 flex items-center justify-between gap-2.5">
        {/* Inline, so on a narrow phone the title wraps and the "?" stays after its last word (no break before it). */}
        <div className="min-w-0 whitespace-nowrap">
          <h2 id="portfolio-earnings-title" className="inline whitespace-normal text-[15px] font-medium text-[var(--color-arco-ink)] md:text-base">{TITLE}</h2>
          {message === null && <HelpTip text={`${tipText(netApyPercent ?? 0)}${whatIf ? ` ${TIP_WHAT_IF}` : ""}`} />}
        </div>
        <div role="group" aria-label="Projection range" className="inline-flex shrink-0 rounded-[var(--radius-pill)] bg-[var(--color-arco-chip)] p-0.5 text-[13px]">
          {PROJECTION_RANGES.map((option) => (
            <button
              key={option.id}
              type="button"
              aria-pressed={range === option.id}
              onClick={() => {
                setRange(option.id)
                setActive(null)
              }}
              className={`rounded-[var(--radius-pill)] px-[11px] py-1.5 md:px-3.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)] ${range === option.id ? SEGMENT_ACTIVE : SEGMENT_IDLE}`}
            >
              {option.id}
            </button>
          ))}
        </div>
      </div>
      {message !== null || !first || !last || !shownPoint || !layout ? (
        <p data-testid="portfolio-earnings-empty" className="flex h-[200px] items-center justify-center px-4 text-center text-sm text-[var(--color-arco-muted-text)]">
          {message}
        </p>
      ) : (
        <>
          {/* Side by side; on the narrowest phones the what-if goes under the readout so the two never collide. */}
          <div className="mb-3 flex flex-col gap-2.5 min-[380px]:flex-row min-[380px]:items-start min-[380px]:justify-between min-[380px]:gap-3">
            <div data-testid="portfolio-earnings-readout" className="flex min-w-0 flex-col gap-[3px]">
              <span data-testid="portfolio-earnings-readout-label" className="text-[12.5px] text-[var(--color-arco-muted-text)]">{point ? point.label : TODAY_LABEL}</span>
              <span data-testid="portfolio-earnings-value" className="text-[17px] font-medium tabular-nums text-[var(--color-arco-ink)] md:text-xl">{money(point ? point.value : first.value)}</span>
              {point ? (
                <span data-testid="portfolio-earnings-interest" className="text-xs tabular-nums text-[var(--color-arco-up-text)]">
                  {interestNote((principal?.earned ?? 0) + point.projectedInterest)}
                </span>
              ) : (
                // Holds the interest line's room at rest, so the header does not jump when the scrubber moves.
                <span aria-hidden="true" className="text-xs">&nbsp;</span>
              )}
            </div>
            {whatIfPoint && (
              <div data-testid="portfolio-earnings-what-if" className="flex min-w-0 flex-col items-start gap-[3px] min-[380px]:items-end min-[380px]:text-right">
                <span className="text-[12.5px] text-[var(--color-arco-muted-text)]">{WHAT_IF_TITLE}</span>
                <span className="text-[17px] font-medium tabular-nums text-[var(--color-arco-up-text)] md:text-xl">{money(whatIfPoint.value)}</span>
                <span className="text-xs tabular-nums text-[var(--color-arco-up-text)]">{whatIfMore(whatIfPoint.value - shownPoint.value)}</span>
              </div>
            )}
          </div>
          <EarningsLine
            key={range}
            range={range}
            today={today}
            months={months}
            whatIfMonths={whatIfMonths}
            layout={layout}
            principal={principal}
            active={active}
            onActive={setActive}
          />
          <div aria-hidden="true" data-testid="portfolio-earnings-legend" className="mt-3 flex flex-wrap gap-x-[18px] gap-y-1.5 text-[12.5px] text-[var(--color-arco-text-soft)]">
            <LegendItem swatch="border-t-[2.5px] border-solid border-[var(--color-arco-chart-1)]">{LEGEND_LINE}</LegendItem>
            {whatIf && <LegendItem swatch="border-t-2 border-dashed border-[var(--color-arco-up-text)]">{WHAT_IF_TITLE}</LegendItem>}
          </div>
          {whatIf && <WhatIfCallToAction whatIf={whatIf} />}
        </>
      )}
    </section>
  )
}

function LegendItem({ swatch, children }: { swatch: string; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-[7px]">
      <i className={`inline-block w-[18px] ${swatch}`} />
      {children}
    </span>
  )
}

function WhatIfCallToAction({ whatIf }: { whatIf: WhatIf }) {
  return (
    <div data-testid="portfolio-earnings-cta" className="mt-3.5 flex flex-col items-start gap-2.5 rounded-2xl bg-[var(--color-portfolio-what-if-soft)] px-4 py-3 text-[13.5px] text-[var(--color-arco-ink)] sm:flex-row sm:items-center sm:justify-between sm:gap-3">
      <p>
        <b className="font-semibold tabular-nums">{money(whatIf.totalUsd)}</b>
        {CTA_IDLE}
      </p>
      <Link
        to={GIWA_SAVINGS_ROUTE}
        className="inline-flex shrink-0 items-center rounded-[var(--radius-pill)] bg-[var(--color-arco-ink)] px-3.5 py-2 text-[13px] font-medium text-[var(--color-arco-on-dark)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
      >
        {CTA_BUTTON}
      </Link>
    </div>
  )
}

/**
 * The "?" next to the title, built like the Savings info tips (SavingsInfoTip: the navy bubble, its text token, a 24px
 * hit area): it opens on hover, on keyboard focus and on a tap, and closes on Escape, on blur and on a tap elsewhere.
 * The bubble hangs from the header row, not the icon, so it stays inside the card on a phone. Screen readers get the
 * text as the button's description.
 */
function HelpTip({ text }: { text: string }) {
  const id = useId()
  const rootRef = useRef<HTMLSpanElement>(null)
  const [hovered, setHovered] = useState(false)
  const [focused, setFocused] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [dismissed, setDismissed] = useState(false)
  const open = !dismissed && (hovered || focused || pinned)
  // Whether it was open when the press began: a tap opens it through hover / focus first, and must not then close it.
  const openAtPress = useRef<boolean | null>(null)
  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node | null)) return
      setPinned(false)
      setHovered(false)
    }
    document.addEventListener("pointerdown", onPointerDown)
    return () => document.removeEventListener("pointerdown", onPointerDown)
  }, [])
  return (
    <span
      ref={rootRef}
      className="ml-1 inline-flex align-middle"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false)
        setDismissed(false)
      }}
    >
      <button
        type="button"
        aria-label={TIP_LABEL}
        aria-describedby={id}
        aria-expanded={open}
        onPointerDown={() => {
          openAtPress.current = open
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          setPinned(false)
          setDismissed(false)
        }}
        onClick={() => {
          const wasOpen = openAtPress.current ?? open
          openAtPress.current = null
          if (wasOpen) {
            setPinned(false)
            setDismissed(true)
          } else {
            setPinned(true)
            setDismissed(false)
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.stopPropagation()
            setPinned(false)
            setDismissed(true)
          }
        }}
        className="inline-flex size-6 items-center justify-center rounded-[var(--radius-pill)] text-[var(--color-arco-muted)] hover:text-[var(--color-arco-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
      >
        <CircleHelp aria-hidden="true" className="size-3.5" />
      </button>
      <span
        id={id}
        role="tooltip"
        data-testid="portfolio-earnings-tip"
        data-open={open ? "true" : "false"}
        className={`absolute left-0 top-full z-30 mt-1 w-full max-w-[340px] rounded-[var(--radius-card)] bg-[var(--color-arco-ink)] px-2.5 py-2 text-left text-xs font-normal leading-[18px] whitespace-normal text-[var(--color-savings-tip-text)] transition-[opacity,visibility] duration-150 motion-reduce:transition-none ${
          open ? "visible opacity-100" : "invisible opacity-0"
        }`}
      >
        {text}
      </span>
    </span>
  )
}

// The plot, drawn in the container's own pixels (measured), so text never stretches. No y labels: the plot spans the
// card, with room at either end for the scrubber's handle.
const FALLBACK_WIDTH = 640
const PAD_LEFT = 14
const PAD_RIGHT = 16
const PLOT_TOP = 22
const PLOT_BOTTOM_ROOM = 28
const AXIS_FONT = 11
/** Rough width of a character of the 11px axis labels, for dropping year labels that would touch. */
const CHAR_W = 6.4
/** The what-if gap's fill: the what-if line's green, light enough that gridlines and the line read through it. */
const WHAT_IF_FILL_OPACITY = 0.12
/** The area under the line: the line's navy fading down to almost nothing. */
const AREA_TOP_OPACITY = 0.16
const AREA_BOTTOM_OPACITY = 0.02
/** The scrubber: its band's half-width and translucency, the handle's radius. */
const BAND_HALF = 9
const BAND_OPACITY = 0.09
const HANDLE_R = 12

function useWidth(ref: RefObject<HTMLElement>): number {
  const [width, setWidth] = useState(0)
  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const read = () => setWidth(element.getBoundingClientRect().width)
    read()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(read)
    observer.observe(element)
    return () => observer.disconnect()
  }, [ref])
  return width
}

const points = (list: readonly { x: number; y: number }[]) => list.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")

/**
 * The line, its area, the what-if and the scrubber. The plot is one focusable slider over the months of the projection:
 * a mouse scrubs by hovering; touch and pen by pressing and dragging (pointer capture; `touch-action: pan-y` leaves
 * vertical page scrolling to the browser) or tapping; the keyboard with Left / Right, Home / End and Escape. The
 * position snaps to the nearest month; leaving with the mouse, releasing outside, Escape or blur put it back to rest.
 */
function EarningsLine({
  range,
  today,
  months,
  whatIfMonths,
  layout,
  principal,
  active,
  onActive,
}: {
  range: ProjectionRange
  today: Date
  months: readonly ProjectionBar[]
  /** The what-if, month by month; null when there is none. */
  whatIfMonths: readonly ProjectionBar[] | null
  /** Where each line's points sit in the plot (0 = bottom, 1 = top). */
  layout: PlotLayout
  principal: { earned: number; supplied: number } | null
  active: number | null
  onActive: (index: number | null) => void
}) {
  const boxRef = useRef<HTMLDivElement>(null)
  const sliderRef = useRef<HTMLDivElement>(null)
  const dragging = useRef<number | null>(null)
  const gradientId = `portfolio-earnings-area-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`
  const measured = useWidth(boxRef)
  const width = measured > 0 ? measured : FALLBACK_WIDTH
  const narrow = width < 480
  const height = narrow ? 190 : 240
  const plotBottom = height - PLOT_BOTTOM_ROOM
  const lastIndex = months.length - 1
  const shownIndex = active ?? lastIndex

  // Back to rest when the window loses focus, and when a press lands outside the chart (a tap elsewhere does not blur
  // the plot in every mobile browser).
  useEffect(() => {
    const rest = () => onActive(null)
    const onPointerDown = (event: PointerEvent) => {
      if (!sliderRef.current?.contains(event.target as Node | null)) rest()
    }
    window.addEventListener("blur", rest)
    document.addEventListener("pointerdown", onPointerDown)
    return () => {
      window.removeEventListener("blur", rest)
      document.removeEventListener("pointerdown", onPointerDown)
    }
  }, [onActive])

  const today0 = months[0]!.value
  const plotW = Math.max(1, width - PAD_LEFT - PAD_RIGHT)
  const total = months[lastIndex]!.month || 1
  const x = (month: number) => PAD_LEFT + (month / total) * plotW
  const y = (height: number) => plotBottom - height * (plotBottom - PLOT_TOP)
  const line = months.map((p, index) => ({ x: x(p.month), y: y(layout.projected[index]!) }))
  const whatIfLine = layout.whatIf ? months.map((p, index) => ({ x: x(p.month), y: y(layout.whatIf![index]!) })) : null
  const area = `M${line[0]!.x.toFixed(1)},${plotBottom.toFixed(1)} L${points(line).replace(/ /g, " L")} L${line[lastIndex]!.x.toFixed(1)},${plotBottom.toFixed(1)} Z`
  // The what-if gap: along the what-if line from Today to the end, then back along the line.
  const whatIfFill = whatIfLine
    ? `M${points(whatIfLine).replace(/ /g, " L")} L${points([...line].reverse()).replace(/ /g, " L")} Z`
    : null

  // X labels: "Today" from the left edge, the end month to the right edge, the years between centred. Where they would
  // touch (a narrow phone), every second (third…) year is kept, counted back from the end; one touching "Today" is left out.
  const [todayTick, ...yearList] = yearTicks(range, today).map((tick, index, all) => {
    const at = x(tick.month)
    const w = tick.label.length * CHAR_W
    const anchor: "start" | "middle" | "end" = index === 0 ? "start" : index === all.length - 1 ? "end" : "middle"
    const left = anchor === "start" ? at : anchor === "end" ? at - w : at - w / 2
    return { ...tick, at, anchor, left, right: left + w }
  })
  const apart = (list: readonly { left: number; right: number }[]) => list.every((tick, i) => i === 0 || tick.left >= list[i - 1]!.right + 8)
  let everyNth = 1
  const thinned = () => yearList.filter((_, i) => (yearList.length - 1 - i) % everyNth === 0)
  while (everyNth < yearList.length && !apart(thinned())) everyNth += 1
  const shownYears = [todayTick!, ...thinned().filter((tick) => tick.left >= todayTick!.right + 8)]

  // The month nearest a pointer, from its position over the plot.
  const indexAt = (clientX: number) => {
    const left = sliderRef.current?.getBoundingClientRect().left ?? 0
    const month = ((clientX - left - PAD_LEFT) / plotW) * total
    return Math.max(0, Math.min(lastIndex, Math.round(month)))
  }
  const outside = (event: ReactPointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (box.width === 0 && box.height === 0) return false
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
  }
  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return
    dragging.current = event.pointerId
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId)
    } catch {
      // Not capturable (a synthetic pointer): the drag still works while the pointer stays over the plot.
    }
    onActive(indexAt(event.clientX))
  }
  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" || dragging.current === event.pointerId) onActive(indexAt(event.clientX))
  }
  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragging.current !== event.pointerId) return
    dragging.current = null
    // A tap or a drag released over the plot keeps its month (a press elsewhere puts it back); released outside, rest.
    if (outside(event)) onActive(null)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const to = event.key === "ArrowRight" || event.key === "ArrowUp" ? shownIndex + 1
      : event.key === "ArrowLeft" || event.key === "ArrowDown" ? shownIndex - 1
        : event.key === "Home" ? 0
          : event.key === "End" ? lastIndex
            : null
    if (event.key === "Escape") {
      if (active !== null) {
        event.stopPropagation()
        onActive(null)
      }
      return
    }
    if (to === null) return
    event.preventDefault()
    onActive(Math.max(0, Math.min(lastIndex, to)))
  }

  const end = months[lastIndex]!
  const whatIfEnd = whatIfMonths?.[whatIfMonths.length - 1]
  const summary = `${months[0]!.label}: ${money(today0)}. ${end.label}: ${money(end.value)} projected, ${plus((principal?.earned ?? 0) + end.projectedInterest)} in interest.${
    whatIfEnd ? ` ${WHAT_IF_TITLE}: ${money(whatIfEnd.value)}, ${whatIfMore(whatIfEnd.value - end.value)}.` : ""
  }`
  const shown = months[shownIndex]!
  const shownWhatIf = whatIfMonths?.[shownIndex]
  const valueText = `${shown.label}: ${money(shown.value)}${shownIndex === 0 ? "" : " projected"}${shownWhatIf ? `, ${WHAT_IF_TITLE.toLowerCase()}: ${money(shownWhatIf.value)}` : ""}`
  const hx = line[shownIndex]!.x
  const hy = line[shownIndex]!.y

  return (
    <div ref={boxRef} data-what-if-scale={whatIfMonths ? layout.scale : undefined} className="relative w-full" style={{ height }}>
      <p className="sr-only">{summary}</p>
      <svg aria-hidden="true" data-testid="portfolio-earnings-svg" width={width} height={height} className="block overflow-visible">
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopOpacity={AREA_TOP_OPACITY} style={{ stopColor: "var(--color-arco-chart-1)" }} />
            <stop offset="1" stopOpacity={AREA_BOTTOM_OPACITY} style={{ stopColor: "var(--color-arco-chart-1)" }} />
          </linearGradient>
        </defs>
        {yearGridMonths(range).map((month) => (
          <line key={month} data-gridline x1={x(month)} x2={x(month)} y1={PLOT_TOP - 6} y2={plotBottom} strokeWidth={1} strokeDasharray="3 4" style={{ stroke: "var(--color-arco-border)" }} />
        ))}
        <path data-testid="portfolio-earnings-area" d={area} fill={`url(#${gradientId})`} />
        {whatIfFill && (
          <path data-testid="portfolio-earnings-what-if-fill" d={whatIfFill} fillOpacity={WHAT_IF_FILL_OPACITY} style={{ fill: "var(--color-arco-up-text)" }} />
        )}
        {whatIfLine && (
          <polyline data-testid="portfolio-earnings-what-if-line" points={points(whatIfLine)} fill="none" strokeWidth={2} strokeDasharray="6 5" strokeLinejoin="round" style={{ stroke: "var(--color-arco-up-text)" }} />
        )}
        <polyline data-testid="portfolio-earnings-line" points={points(line)} fill="none" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" style={{ stroke: "var(--color-arco-chart-1)" }} />
        {shownYears.map((tick) => (
          <text key={tick.month} data-axis-year x={tick.at} y={height - 8} textAnchor={tick.anchor} fontSize={AXIS_FONT} style={{ fill: "var(--color-arco-muted-text)" }}>
            {tick.label}
          </text>
        ))}
        <g data-testid="portfolio-earnings-scrubber" data-index={shownIndex} data-active={active !== null ? "true" : "false"}>
          <rect
            data-testid="portfolio-earnings-band"
            x={hx - BAND_HALF}
            y={PLOT_TOP - 6}
            width={BAND_HALF * 2}
            height={plotBottom - PLOT_TOP + 6}
            rx={4}
            fillOpacity={BAND_OPACITY}
            style={{ fill: "var(--color-arco-chart-1)" }}
          />
          {whatIfLine && (
            <circle data-testid="portfolio-earnings-what-if-dot" cx={hx} cy={whatIfLine[shownIndex]!.y} r={4.5} strokeWidth={2} style={{ fill: "var(--color-arco-up-text)", stroke: "var(--color-arco-surface)" }} />
          )}
          <circle data-testid="portfolio-earnings-handle" cx={hx} cy={hy} r={HANDLE_R} strokeWidth={3} style={{ fill: "var(--color-arco-chart-1)", stroke: "var(--color-arco-surface)" }} />
          {/* ◀▶ */}
          <path
            d={`M${(hx - 1.6).toFixed(1)},${(hy - 4.5).toFixed(1)} L${(hx - 6.2).toFixed(1)},${hy.toFixed(1)} L${(hx - 1.6).toFixed(1)},${(hy + 4.5).toFixed(1)} Z M${(hx + 1.6).toFixed(1)},${(hy - 4.5).toFixed(1)} L${(hx + 6.2).toFixed(1)},${hy.toFixed(1)} L${(hx + 1.6).toFixed(1)},${(hy + 4.5).toFixed(1)} Z`}
            style={{ fill: "var(--color-arco-surface)" }}
          />
        </g>
      </svg>
      <div
        ref={sliderRef}
        role="slider"
        tabIndex={0}
        aria-label="Projected value by month"
        aria-orientation="horizontal"
        aria-valuemin={0}
        aria-valuemax={lastIndex}
        aria-valuenow={shownIndex}
        aria-valuetext={valueText}
        data-testid="portfolio-earnings-slider"
        className="absolute inset-0 cursor-pointer touch-pan-y select-none rounded-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-arco-ink)]"
        style={{ touchAction: "pan-y" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => {
          // The browser took the gesture (a vertical scroll): back to rest.
          dragging.current = null
          onActive(null)
        }}
        onPointerLeave={(event) => {
          // Mouse only: a finger lifting also "leaves", and a tap keeps its month.
          if (event.pointerType === "mouse" && dragging.current === null) onActive(null)
        }}
        onFocus={(event) => {
          // Only a keyboard focus points at a month (the handle's resting one). A click focuses the plot too, and the
          // browser focuses it again whenever the window comes back: that must not pin a month.
          if (active === null && isKeyboardFocus(event.currentTarget)) onActive(lastIndex)
        }}
        onBlur={() => onActive(null)}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
