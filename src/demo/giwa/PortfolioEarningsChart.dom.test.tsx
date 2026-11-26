// "Your potential earnings" on its own: the header readout at rest and under the scrubber (mouse, touch, keyboard); the
// what-if line only for idle coins at a known Savings rate, its gap compressed when it dwarfs the projection; the "?" tip
// on hover, focus and tap; the variant without a known principal. Gated like the other DOM tests
// (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"
import type { PortfolioEarningsChartProps } from "./PortfolioEarningsChart"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME
const TIP = "Estimate only, at today's 4% Net APY with nothing added or withdrawn. Rates change; returns are not guaranteed. The vertical axis starts near what you supplied, not at zero."

test("potential earnings line chart: scrubber, header readout, what-if, balanced drawing, help tip (set GIWA_HOST_DOM_RUNTIME)", { skip: !runtime }, async (t) => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><div id="outside"></div></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element,
    Node: w.Node, Event: w.Event, MouseEvent: w.MouseEvent, PointerEvent: w.PointerEvent, KeyboardEvent: w.KeyboardEvent, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  t.after(() => {
    dom.window.close()
    for (const key of Object.keys(globals)) {
      const before = previous[key]
      if (before) Object.defineProperty(globalThis, key, before)
      else Reflect.deleteProperty(globalThis, key)
    }
  })
  const React = (await import("react")) as AnyModule
  const { createRoot } = (await import("react-dom/client")) as AnyModule
  const { MemoryRouter } = (await import("react-router-dom")) as AnyModule
  const { PortfolioEarningsChart } = (await import("./PortfolioEarningsChart")) as AnyModule
  const { money } = await import("../lib/format")
  const { projectMonths, whatIfOf } = await import("./portfolio-projection")
  const { chartAxis, BALANCED_MIN_RISE_SHARE, COMPRESSED_RISE_SHARE, PLOT_BOTTOM_PAD_SHARE, PLOT_TOP_PAD_SHARE } = await import("./portfolio-chart-axis")

  // $11,000 deposited, $10,000 of it earning 4% ($10,800 supplied, $200 earned) and, by default, idle coins outside it:
  // $1,000 that Savings would pay 5% on and $500 at 2%.
  const IDLE = [{ usd: 1_000, apyPercent: 5 }, { usd: 500, apyPercent: 2 }]
  const base: PortfolioEarningsChartProps = {
    value: 11_000, earningUsd: 10_000, apyPercent: 4, netApyPercent: 4, earned: 200, supplied: 10_800,
    idleAssets: IDLE, emptyLabel: null, today: new Date(2026, 10, 26),
  }
  // jsdom lays nothing out: the plot is 640px wide (the fallback), 14px in from the left and 16px from the right.
  const WIDTH = 640, PAD_LEFT = 14, PLOT_W = 640 - 14 - 16, HEIGHT = 240, PLOT_TOP = 22, PLOT_BOTTOM = 240 - 28
  const xOf = (month: number, total = 36) => PAD_LEFT + (month / total) * PLOT_W
  const pointer = (type: string, init: { clientX?: number; clientY?: number; pointerType?: string; pointerId?: number; relatedTarget?: EventTarget | null } = {}) =>
    new w.PointerEvent(type, { bubbles: true, cancelable: true, clientX: 0, clientY: 100, pointerType: "mouse", pointerId: 1, button: 0, ...init })
  const project = (idle: readonly { usd: number; apyPercent: number }[] | null, range: "3Y" | "5Y" | "10Y" = "3Y") =>
    projectMonths({ value: 11_000, earningUsd: 10_000, apyPercent: 4, range, today: base.today, whatIf: whatIfOf(idle) })

  async function mount(props: Partial<PortfolioEarningsChartProps> = {}) {
    const element = w.document.createElement("div")
    w.document.body.append(element)
    const root = createRoot(element)
    await React.act(async () => root.render(React.createElement(MemoryRouter, null, React.createElement(PortfolioEarningsChart, { ...base, ...props }))))
    const part = (id: string) => element.querySelector(`[data-testid="${id}"]`)
    const text = (id: string) => part(id)?.textContent ?? null
    const slider = () => element.querySelector('[role="slider"]') as HTMLElement | null
    const fire = async (node: EventTarget, event: Event) => React.act(async () => { node.dispatchEvent(event) })
    const svg = () => part("portfolio-earnings-svg")!
    const chip = (id: string) => [...element.querySelectorAll('[aria-label="Projection range"] button')].find((button) => button.textContent === id)!
    const label = () => text("portfolio-earnings-readout-label")
    return { element, part, text, slider, fire, svg, chip, label, close: async () => { await React.act(async () => root.unmount()); element.remove() } }
  }
  const ys = (m: { part: (id: string) => Element | null }, id: string) => m.part(id)!.getAttribute("points")!.split(" ").map((pair) => Number(pair.split(",")[1]))
  const lastY = (m: { part: (id: string) => Element | null }, id: string) => ys(m, id).slice(-1)[0]!
  const scaleOf = (m: { element: HTMLElement }) => m.element.querySelector("[data-what-if-scale]")?.getAttribute("data-what-if-scale") ?? null
  // The plot's points at true scale (one axis for both lines), as the chart drew them before balanced drawing.
  const trueScalePoints = (values: readonly number[], all: readonly number[], base: number) => {
    const axis = chartAxis(base, all)
    return values.map((value, month) => `${xOf(month).toFixed(1)},${(PLOT_BOTTOM - ((value - axis.min) / (axis.max - axis.min || 1)) * (PLOT_BOTTOM - PLOT_TOP)).toFixed(1)}`).join(" ")
  }

  await t.test("header at rest: today's value on the left, the what-if at the end on the right; no tooltip, end block or y labels", async () => {
    const m = await mount()
    try {
      const line = project(null), withIdle = project(IDLE)
      assert.equal(m.text("portfolio-earnings-readout"), "Today · Current value$11,000.00 ", "the interest line's room is held")
      assert.equal(m.part("portfolio-earnings-interest"), null)
      assert.equal(m.text("portfolio-earnings-what-if"), `With idle assets in Savings${money(withIdle[36]!.value)}+${money(withIdle[36]!.value - line[36]!.value)} more interest`)
      assert.equal(m.part("portfolio-earnings-end"), null, "no end-value block")
      assert.equal(m.part("portfolio-earnings-tooltip"), null, "no floating tooltip")
      assert.equal(m.element.querySelectorAll("[data-axis-tick]").length, 0, "no y labels")
      assert.equal(m.part("portfolio-earnings-baseline"), null, "no Supplied baseline")
      assert.equal(m.svg().querySelectorAll("line:not([data-gridline])").length, 0, "no horizontal gridlines")
      assert.match(m.element.querySelector(".sr-only")?.textContent ?? "", /^Today: \$11,000\.00\. Nov 2029: .+ projected, \+\$.+ in interest\. With idle assets in Savings: \$[\d,.]+, \+\$[\d,.]+ more interest\.$/)
      // The scrubber rests on the end: the handle on the line's last point, not clipped, the what-if dot above it.
      const scrubber = m.part("portfolio-earnings-scrubber")!
      assert.equal(scrubber.getAttribute("data-index"), "36")
      assert.equal(scrubber.getAttribute("data-active"), "false")
      const handle = m.part("portfolio-earnings-handle")!
      const cx = Number(handle.getAttribute("cx")), r = Number(handle.getAttribute("r"))
      assert.ok(Math.abs(cx - xOf(36)) < 1e-6)
      assert.ok(cx + r + 1.5 <= WIDTH, "the handle (and its ring) inside the plot on the right")
      assert.ok(Math.abs(Number(handle.getAttribute("cy")) - lastY(m, "portfolio-earnings-line")) < 0.1)
      assert.equal(m.part("portfolio-earnings-band")!.getAttribute("fill-opacity"), "0.09")
      assert.ok(Number(m.part("portfolio-earnings-what-if-dot")!.getAttribute("cy")) < Number(handle.getAttribute("cy")))
      // X labels: Today, the years between, the end month.
      assert.deepEqual([...m.element.querySelectorAll("[data-axis-year]")].map((tick) => tick.textContent), ["Today", "2027", "2028", "Nov 2029"])
      // The slider: one tab stop over the 37 months, at the end.
      const slider = m.slider()!
      assert.equal(slider.getAttribute("aria-label"), "Projected value by month")
      assert.equal(slider.tabIndex, 0)
      assert.deepEqual(["aria-valuemin", "aria-valuemax", "aria-valuenow"].map((name) => slider.getAttribute(name)), ["0", "36", "36"])
      assert.equal(slider.getAttribute("aria-valuetext"), `Nov 2029: ${money(line[36]!.value)} projected, with idle assets in savings: ${money(withIdle[36]!.value)}`)
      assert.match(slider.getAttribute("style") ?? "", /touch-action: pan-y/)
      assert.equal(m.element.querySelectorAll("button").length, 4, "the three ranges and the '?': no point buttons")
    } finally { await m.close() }
  })

  await t.test("vertical gridlines at Today and every year boundary, per range; the scrubber resets with the range", async () => {
    const m = await mount()
    try {
      const grid = () => [...m.svg().querySelectorAll("[data-gridline]")]
      assert.equal(grid().length, 4)
      assert.ok(grid().every((line) => line.getAttribute("x1") === line.getAttribute("x2") && line.getAttribute("stroke-dasharray") === "3 4"), "vertical and dashed")
      assert.deepEqual(grid().map((line) => Number(line.getAttribute("x1")).toFixed(1)), [0, 12, 24, 36].map((month) => xOf(month).toFixed(1)))
      await m.fire(m.slider()!, pointer("pointermove", { clientX: xOf(12) }))
      assert.equal(m.label(), "Nov 2027")
      await m.fire(m.chip("5Y"), new w.MouseEvent("click", { bubbles: true }))
      assert.equal(grid().length, 6)
      assert.equal(m.label(), "Today · Current value", "a new range starts at rest")
      assert.equal(m.part("portfolio-earnings-scrubber")!.getAttribute("data-index"), "60")
      assert.equal(m.slider()!.getAttribute("aria-valuemax"), "60")
      assert.equal([...m.element.querySelectorAll("[data-axis-year]")].slice(-1)[0]!.textContent, "Nov 2031")
      await m.fire(m.chip("10Y"), new w.MouseEvent("click", { bubbles: true }))
      assert.equal(grid().length, 11)
      assert.equal(m.slider()!.getAttribute("aria-valuemax"), "120")
      assert.deepEqual([...m.element.querySelectorAll("[data-axis-year]")].map((tick) => tick.textContent), ["Today", "2028", "2030", "2032", "2034", "Nov 2036"])
    } finally { await m.close() }
  })

  await t.test("mouse: hovering scrubs to the nearest month, both header slots follow; leaving or releasing outside rests", async () => {
    const m = await mount()
    try {
      const line = project(null), withIdle = project(IDLE)
      const slider = m.slider()!
      // Snaps: a little right of Nov 2028 (month 24) is still Nov 2028.
      await m.fire(slider, pointer("pointermove", { clientX: xOf(24) + 3 }))
      assert.equal(m.text("portfolio-earnings-readout"), `Nov 2028${money(line[24]!.value)}+${money(200 + line[24]!.projectedInterest)} interest`)
      assert.equal(m.text("portfolio-earnings-what-if"), `With idle assets in Savings${money(withIdle[24]!.value)}+${money(withIdle[24]!.value - line[24]!.value)} more interest`)
      assert.equal(m.part("portfolio-earnings-scrubber")!.getAttribute("data-active"), "true")
      assert.ok(Math.abs(Number(m.part("portfolio-earnings-handle")!.getAttribute("cx")) - xOf(24)) < 1e-6)
      assert.ok(Math.abs(Number(m.part("portfolio-earnings-band")!.getAttribute("x")) - (xOf(24) - 9)) < 1e-6, "the band centred on the handle")
      assert.equal(slider.getAttribute("aria-valuenow"), "24")
      assert.equal(slider.getAttribute("aria-valuetext"), `Nov 2028: ${money(line[24]!.value)} projected, with idle assets in savings: ${money(withIdle[24]!.value)}`)
      // Past either end: clamped to Today / the end. Today shows what was earned so far.
      await m.fire(slider, pointer("pointermove", { clientX: -40 }))
      assert.equal(m.text("portfolio-earnings-readout"), "Today$11,000.00+$200.00 interest")
      assert.equal(m.text("portfolio-earnings-what-if"), "With idle assets in Savings$11,000.00+$0.00 more interest")
      assert.ok(Number(m.part("portfolio-earnings-handle")!.getAttribute("cx")) - 13.5 >= 0, "the handle not clipped on the left")
      await m.fire(slider, pointer("pointermove", { clientX: 2_000 }))
      assert.equal(m.label(), "Nov 2029")
      // Leaving with the mouse: rest.
      await m.fire(slider, pointer("pointerout", { relatedTarget: w.document.getElementById("outside") }))
      assert.equal(m.label(), "Today · Current value")
      assert.equal(m.part("portfolio-earnings-scrubber")!.getAttribute("data-index"), "36")
      // Press and drag, released outside the plot: rest.
      Object.defineProperty(slider, "getBoundingClientRect", { configurable: true, value: () => ({ left: 0, top: 0, right: WIDTH, bottom: HEIGHT, width: WIDTH, height: HEIGHT, x: 0, y: 0 }) })
      await m.fire(slider, pointer("pointerdown", { clientX: xOf(6) }))
      assert.equal(m.label(), "May 2027")
      await m.fire(slider, pointer("pointermove", { clientX: xOf(9) }))
      assert.equal(m.label(), "Aug 2027")
      await m.fire(slider, pointer("pointerup", { clientX: xOf(9), clientY: 400 }))
      assert.equal(m.label(), "Today · Current value", "released outside: rest")
      // Released over the plot: the month stays.
      await m.fire(slider, pointer("pointerdown", { clientX: xOf(9) }))
      await m.fire(slider, pointer("pointerup", { clientX: xOf(9) }))
      assert.equal(m.label(), "Aug 2027")
    } finally { await m.close() }
  })

  await t.test("touch: a tap or a drag scrubs and stays; a press elsewhere or a scroll (pointercancel) rests", async () => {
    const m = await mount()
    try {
      const slider = m.slider()!
      const touch = { pointerType: "touch", pointerId: 7 }
      // A finger moving over the plot without pressing it first does nothing (touch has no hover).
      await m.fire(slider, pointer("pointermove", { ...touch, clientX: xOf(3) }))
      assert.equal(m.label(), "Today · Current value")
      await m.fire(slider, pointer("pointerdown", { ...touch, clientX: xOf(12) }))
      assert.equal(m.label(), "Nov 2027")
      await m.fire(slider, pointer("pointermove", { ...touch, clientX: xOf(30) }))
      assert.equal(m.label(), "May 2029")
      await m.fire(slider, pointer("pointerup", { ...touch, clientX: xOf(30) }))
      await m.fire(slider, pointer("pointerout", { ...touch, relatedTarget: w.document.getElementById("outside") }))
      assert.equal(m.label(), "May 2029", "a lifted finger keeps its month")
      await m.fire(w.document.body, pointer("pointerdown", { ...touch, pointerId: 8 }))
      assert.equal(m.label(), "Today · Current value", "a press elsewhere: rest")
      await m.fire(slider, pointer("pointerdown", { ...touch, clientX: xOf(18) }))
      assert.equal(m.label(), "May 2028")
      await m.fire(slider, pointer("pointercancel", touch))
      assert.equal(m.label(), "Today · Current value", "the page scrolled: rest")
      // The window losing focus rests it too.
      await m.fire(slider, pointer("pointerdown", { ...touch, clientX: xOf(18) }))
      await m.fire(w, new w.Event("blur"))
      assert.equal(m.label(), "Today · Current value")
    } finally { await m.close() }
  })

  await t.test("keyboard: focus points at the end; Left / Right one month, Home / End; Escape and blur rest", async () => {
    const m = await mount()
    try {
      const line = project(null)
      const slider = m.slider()!
      const key = (name: string) => m.fire(slider, new w.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }))
      // jsdom cannot tell focus-visible, so a focus counts as keyboard.
      await React.act(async () => slider.focus())
      assert.equal(m.text("portfolio-earnings-readout"), `Nov 2029${money(line[36]!.value)}+${money(200 + line[36]!.projectedInterest)} interest`)
      assert.match(slider.className, /focus-visible:outline-2/)
      await key("ArrowLeft")
      assert.equal(m.label(), "Oct 2029")
      assert.equal(slider.getAttribute("aria-valuenow"), "35")
      await key("ArrowRight"); await key("ArrowRight")
      assert.equal(slider.getAttribute("aria-valuenow"), "36", "stops at the end")
      await key("Home")
      assert.equal(m.label(), "Today")
      assert.equal(slider.getAttribute("aria-valuetext"), "Today: $11,000.00, with idle assets in savings: $11,000.00")
      await key("ArrowLeft")
      assert.equal(slider.getAttribute("aria-valuenow"), "0", "stops at Today")
      await key("ArrowRight")
      assert.equal(m.label(), "Dec 2026")
      await key("End")
      assert.equal(m.label(), "Nov 2029")
      await key("Escape")
      assert.equal(m.label(), "Today · Current value")
      await key("Home")
      assert.equal(m.label(), "Today")
      await React.act(async () => slider.blur())
      assert.equal(m.label(), "Today · Current value", "blur: rest")
      assert.equal(slider.getAttribute("aria-valuenow"), "36")
    } finally { await m.close() }
  })

  await t.test("the what-if line: the interest idle coins would earn in Savings, from $1 of them at known rates", async () => {
    const m = await mount()
    try {
      // 10,000 × 1.04³ + 1,000 flat, and the what-if adds 1,000 × (1.05³ − 1) + 500 × (1.02³ − 1): their interest only.
      const normal = project(null)[36]!.value
      const whatIf = project(IDLE)[36]!.value
      assert.ok(Math.abs(normal - (10_000 * 1.04 ** 3 + 1_000)) < 1e-6)
      assert.ok(Math.abs(whatIf - normal - (1_000 * (1.05 ** 3 - 1) + 500 * (1.02 ** 3 - 1))) < 0.01)
      assert.equal(m.part("portfolio-earnings-what-if-line")!.getAttribute("stroke-dasharray"), "6 5")
      // The gap between the what-if line and the line: the what-if green, translucent, drawn before (behind) both lines.
      const fill = m.part("portfolio-earnings-what-if-fill") as SVGPathElement | null
      assert.ok(fill)
      assert.equal(fill.getAttribute("fill-opacity"), "0.12")
      assert.match(fill.getAttribute("style") ?? "", /^fill: var\(--color-arco-up-text\);?$/)
      assert.match(fill.getAttribute("d") ?? "", /^M[\d.,L ]+Z$/)
      assert.equal(fill.getAttribute("d")!.split("L").length, 2 * 37, "the what-if line month by month (37 points over 3Y), then the line back")
      const drawn = [...m.svg().children]
      const order = (id: string) => drawn.indexOf(m.part(id)!)
      assert.ok(order("portfolio-earnings-area") < order("portfolio-earnings-what-if-fill"))
      assert.ok(order("portfolio-earnings-what-if-fill") < order("portfolio-earnings-what-if-line"))
      assert.ok(order("portfolio-earnings-what-if-fill") < order("portfolio-earnings-line"))
      assert.ok(order("portfolio-earnings-line") < order("portfolio-earnings-scrubber"), "the scrubber on top")
      // The area under the line: a vertical gradient of the line's token.
      const stops = [...m.svg().querySelectorAll("linearGradient stop")]
      assert.deepEqual(stops.map((stop) => stop.getAttribute("stop-opacity")), ["0.16", "0.02"])
      assert.ok(stops.every((stop) => /stop-color: var\(--color-arco-chart-1\)/.test(stop.getAttribute("style") ?? "")))
      assert.equal(m.part("portfolio-earnings-area")!.getAttribute("fill"), `url(#${m.svg().querySelector("linearGradient")!.id})`)
      // Balanced at true scale: drawn exactly as before (one axis taking the what-if in, its end under the plot's top).
      assert.equal(scaleOf(m), "true")
      const n = project(null).map((p) => p.value), wi = project(IDLE).map((p) => p.value)
      assert.equal(m.part("portfolio-earnings-line")!.getAttribute("points"), trueScalePoints(n, [...n, ...wi], 10_800))
      assert.equal(m.part("portfolio-earnings-what-if-line")!.getAttribute("points"), trueScalePoints(wi, [...n, ...wi], 10_800))
      assert.ok(lastY(m, "portfolio-earnings-what-if-line") < lastY(m, "portfolio-earnings-line") && lastY(m, "portfolio-earnings-what-if-line") > PLOT_TOP)
      assert.equal(m.text("portfolio-earnings-legend"), "Projected balanceWith idle assets in Savings")
      assert.equal(m.part("portfolio-earnings-compare"), null, "no compare bars")
      assert.equal(m.text("portfolio-earnings-cta"), "$1,500.00 is not earning.Move to Savings →")
      assert.equal(m.part("portfolio-earnings-cta")?.querySelector("a")?.getAttribute("href"), "/savings")
      assert.equal(m.text("portfolio-earnings-tip"), `${TIP} The dashed line adds the interest your idle assets would earn at today's Savings rates; it is not a promise.`)
      assert.doesNotMatch(m.element.textContent ?? "", /If your idle assets were in Savings/, "the old label is gone")
    } finally { await m.close() }
    for (const [label, props] of [
      ["no idle coins", { idleAssets: [] }],
      ["dust", { idleAssets: [{ usd: 0.6, apyPercent: 5 }, { usd: 0.3, apyPercent: 2 }] }],
      ["no Savings rate", { idleAssets: [{ usd: 1_000, apyPercent: Number.NaN }] }],
      ["a zero Savings rate", { idleAssets: [{ usd: 1_000, apyPercent: 0 }] }],
    ] as const) {
      const none = await mount(props)
      try {
        assert.equal(none.part("portfolio-earnings-what-if"), null, label)
        assert.equal(none.part("portfolio-earnings-what-if-line"), null, label)
        assert.equal(none.part("portfolio-earnings-what-if-fill"), null, label)
        assert.equal(none.part("portfolio-earnings-what-if-dot"), null, label)
        assert.equal(none.svg().querySelectorAll("path").length, 2, `${label}: the area under the line and the handle's arrows`)
        assert.equal(none.part("portfolio-earnings-cta"), null, label)
        assert.equal(none.part("portfolio-earnings-compare"), null, label)
        assert.equal(scaleOf(none), null, `${label}: no what-if scale`)
        const n = project(null).map((p) => p.value)
        assert.equal(none.part("portfolio-earnings-line")!.getAttribute("points"), trueScalePoints(n, n, 10_800), `${label}: the projected line as before`)
        assert.equal(none.text("portfolio-earnings-legend"), "Projected balance", label)
        assert.equal(none.text("portfolio-earnings-tip"), TIP, label)
        await none.fire(none.slider()!, pointer("pointermove", { clientX: xOf(24) }))
        assert.equal(none.label(), "Nov 2028", label)
        assert.equal(none.part("portfolio-earnings-what-if"), null, label)
        assert.doesNotMatch(none.slider()!.getAttribute("aria-valuetext") ?? "", /idle assets/, label)
      } finally { await none.close() }
    }
  })

  await t.test("balanced drawing: true scale while the line rises enough, else the what-if gap is compressed; always drawn", async () => {
    // $10,000 earning 4% over 3Y gains G = 10,000 × (1.04³ − 1); idle coins at the same 4% add E = usd × (1.04³ − 1). At true
    // scale the line rises G / ((1 + 0.1 + 0.12) × (11,000 + G + E − 10,800)) of the plot: 35% at about $11,817 of them.
    const idle = (usd: number) => [{ usd, apyPercent: 4 }]
    const H = PLOT_BOTTOM - PLOT_TOP
    const G = 10_000 * (1.04 ** 3 - 1)
    const riseAtTrueScale = (usd: number) => G / (1.22 * (200 + G + usd * (1.04 ** 3 - 1)))
    assert.ok(riseAtTrueScale(11_700) >= BALANCED_MIN_RISE_SHARE && riseAtTrueScale(11_950) < BALANCED_MIN_RISE_SHARE)
    const tip = (m: { text: (id: string) => string | null }) => m.text("portfolio-earnings-tip") ?? ""
    const TIP_WITH_WHAT_IF = `${TIP} The dashed line adds the interest your idle assets would earn at today's Savings rates; it is not a promise.`
    const balanced = await mount({ idleAssets: idle(11_700) })
    try {
      assert.equal(scaleOf(balanced), "true", "just inside the rule: true scale")
      const n = project(null).map((p) => p.value), wi = project(idle(11_700)).map((p) => p.value)
      assert.equal(balanced.part("portfolio-earnings-what-if-line")!.getAttribute("points"), trueScalePoints(wi, [...n, ...wi], 10_800))
      assert.ok((ys(balanced, "portfolio-earnings-line")[0]! - lastY(balanced, "portfolio-earnings-line")) / H >= BALANCED_MIN_RISE_SHARE - 0.01)
      assert.equal(tip(balanced), TIP_WITH_WHAT_IF)
    } finally { await balanced.close() }
    for (const usd of [11_950, 30_100, 330_000]) {
      const m = await mount({ idleAssets: idle(usd) })
      try {
        const label = `$${usd} idle`
        assert.equal(scaleOf(m), "compressed", label)
        // Always drawn: the line, its fill, the dot, the legend entry; no compare bars.
        assert.ok(m.part("portfolio-earnings-what-if-line"), label)
        assert.ok(m.part("portfolio-earnings-what-if-fill"), label)
        assert.ok(m.part("portfolio-earnings-what-if-dot"), label)
        assert.equal(m.text("portfolio-earnings-legend"), "Projected balanceWith idle assets in Savings", label)
        assert.equal(m.part("portfolio-earnings-compare"), null, label)
        // Today at the bottom padding, the projected line rising its fixed share, the what-if end at the top padding.
        const line = ys(m, "portfolio-earnings-line"), whatIf = ys(m, "portfolio-earnings-what-if-line")
        const near = (a: number, b: number) => assert.ok(Math.abs(a - b) <= 0.1, `${label}: ${a} vs ${b}`)
        near(line[0]!, PLOT_BOTTOM - PLOT_BOTTOM_PAD_SHARE * H)
        near(line[0]! - line[36]!, COMPRESSED_RISE_SHARE * H)
        near(whatIf[36]!, PLOT_TOP + PLOT_TOP_PAD_SHARE * H)
        near(whatIf[0]!, line[0]!)
        assert.ok(whatIf.every((y, index) => y <= line[index]! + 0.05), `${label}: the what-if never below the line`)
        // The gap is linear in the extra interest: halfway in dollars is halfway in pixels.
        const n = project(null), wi = project(idle(usd))
        const share = (wi[18]!.value - n[18]!.value) / (wi[36]!.value - n[36]!.value)
        near(line[18]! - whatIf[18]!, share * (line[36]! - whatIf[36]!))
        // The "?" tip is the same as at true scale; the header's numbers stay exact; the dot follows the drawn what-if.
        assert.equal(tip(m), TIP_WITH_WHAT_IF, label)
        assert.equal(m.text("portfolio-earnings-what-if"), `With idle assets in Savings${money(wi[36]!.value)}+${money(wi[36]!.value - n[36]!.value)} more interest`)
        await m.fire(m.slider()!, pointer("pointermove", { clientX: xOf(12) }))
        assert.equal(m.text("portfolio-earnings-readout"), `Nov 2027${money(n[12]!.value)}+${money(200 + n[12]!.projectedInterest)} interest`)
        assert.equal(m.text("portfolio-earnings-what-if"), `With idle assets in Savings${money(wi[12]!.value)}+${money(wi[12]!.value - n[12]!.value)} more interest`)
        near(Number(m.part("portfolio-earnings-what-if-dot")!.getAttribute("cy")), whatIf[12]!)
        near(Number(m.part("portfolio-earnings-handle")!.getAttribute("cy")), line[12]!)
      } finally { await m.close() }
    }
    // 10Y: the same shares at the range's end.
    const ten = await mount({ idleAssets: idle(330_000) })
    try {
      await ten.fire(ten.chip("10Y"), new w.MouseEvent("click", { bubbles: true }))
      assert.equal(scaleOf(ten), "compressed")
      const line = ys(ten, "portfolio-earnings-line"), whatIf = ys(ten, "portfolio-earnings-what-if-line")
      assert.equal(line.length, 121)
      assert.ok(Math.abs(line[0]! - line[120]! - COMPRESSED_RISE_SHARE * H) <= 0.1)
      assert.ok(Math.abs(whatIf[120]! - (PLOT_TOP + PLOT_TOP_PAD_SHARE * H)) <= 0.1)
      assert.equal(ten.text("portfolio-earnings-cta"), "$330,000.00 is not earning.Move to Savings →")
    } finally { await ten.close() }
  })

  await t.test("the '?' tip: described to screen readers; opens on hover, focus and tap; Escape, blur and a tap elsewhere close it", async () => {
    const m = await mount({ idleAssets: null })
    try {
      const button = m.element.querySelector('button[aria-label="About this estimate"]') as HTMLElement
      const tip = m.part("portfolio-earnings-tip")!
      assert.equal(tip.getAttribute("role"), "tooltip")
      assert.equal(button.getAttribute("aria-describedby"), tip.id)
      assert.equal(tip.textContent, TIP)
      const open = () => tip.getAttribute("data-open")
      assert.equal(open(), "false")
      // Hover.
      await m.fire(button, new w.MouseEvent("mouseover", { bubbles: true }))
      assert.equal(open(), "true")
      await m.fire(button, new w.MouseEvent("mouseout", { bubbles: true, relatedTarget: w.document.getElementById("outside") }))
      assert.equal(open(), "false")
      // Keyboard focus, Escape, blur.
      await React.act(async () => button.focus())
      assert.equal(open(), "true")
      await m.fire(button, new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
      assert.equal(open(), "false")
      await React.act(async () => button.blur())
      assert.equal(open(), "false")
      // A tap (press then click) opens it and keeps it open; a tap elsewhere closes it; a second tap on it closes it.
      await m.fire(button, new w.Event("pointerdown", { bubbles: true }))
      await m.fire(button, new w.MouseEvent("click", { bubbles: true }))
      assert.equal(open(), "true")
      await m.fire(w.document.body, new w.Event("pointerdown", { bubbles: true }))
      assert.equal(open(), "false")
      await m.fire(button, new w.Event("pointerdown", { bubbles: true }))
      await m.fire(button, new w.MouseEvent("click", { bubbles: true }))
      assert.equal(open(), "true")
      await m.fire(button, new w.Event("pointerdown", { bubbles: true }))
      await m.fire(button, new w.MouseEvent("click", { bubbles: true }))
      assert.equal(open(), "false")
      // No fine-print paragraph under the chart any more.
      assert.equal([...m.element.querySelectorAll("p")].filter((p) => /Estimate only/.test(p.textContent ?? "")).length, 0)
    } finally { await m.close() }
  })

  await t.test("principal unknown: the axis starts near the current value; only projected interest; empty states as before", async () => {
    const m = await mount({ earned: null, supplied: null, idleAssets: null })
    try {
      assert.equal(m.part("portfolio-earnings-baseline"), null)
      assert.equal(m.text("portfolio-earnings-legend"), "Projected balance")
      // Interest under a month is the projected interest only.
      await m.fire(m.slider()!, pointer("pointermove", { clientX: xOf(36) }))
      assert.equal(m.text("portfolio-earnings-interest"), `+${money(10_000 * (1.04 ** 3 - 1))} interest`)
      await m.fire(m.slider()!, pointer("pointermove", { clientX: xOf(0) }))
      assert.equal(m.text("portfolio-earnings-readout"), "Today$11,000.00+$0.00 interest")
      // The line starts above the plot's foot: the axis starts a little below today's value.
      const firstY = Number(m.part("portfolio-earnings-line")!.getAttribute("points")!.split(" ")[0]!.split(",")[1])
      assert.ok(firstY < PLOT_BOTTOM - 5, String(firstY))
    } finally { await m.close() }
    const flat = await mount({ apyPercent: null })
    try {
      assert.equal(flat.text("portfolio-earnings-empty"), "Potential earnings show once your holdings have a current APY.")
      assert.equal(flat.slider(), null)
      assert.equal(flat.part("portfolio-earnings-cta"), null, "no what-if without a chart")
    } finally { await flat.close() }
    const loading = await mount({ emptyLabel: "Loading your potential earnings…" })
    try {
      assert.equal(loading.text("portfolio-earnings-empty"), "Loading your potential earnings…")
    } finally { await loading.close() }
  })
})
