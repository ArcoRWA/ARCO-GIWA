// The rows under the Savings card in React DOM: each row opens and closes on its own (aria-expanded follows), and the
// Backing row's pill toggle switches between By manager and By asset type (aria-pressed follows). Gated like the other
// DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("rows under the card: open and close each on its own; Backing switches By manager / By asset type (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement,
    Element: w.Element, Node: w.Node, Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent,
    MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    // React DOM detects its event support when first loaded, so it is loaded only once the DOM globals exist.
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { SavingsAccordion } = (await import("./SavingsAccordion")) as AnyModule
    const { BackingBar, BackingBreakdown, LiquidityBreakdown } = (await import("./SavingsBreakdown")) as AnyModule
    const { savingsBacking, savingsExposure } = (await import("./savings-backing")) as AnyModule
    const { act, createElement: h } = React

    const backing = savingsBacking({ symbol: "USDC", icon: "/logos/usdc.svg" })
    const root = createRoot(w.document.getElementById("root")!)
    await act(async () =>
      root.render(
        h(SavingsAccordion, {
          sections: [
            {
              id: "backing",
              title: "Backing",
              icon: null,
              summary: null,
              preview: h(BackingBar, { slices: backing, tone: "blue" }),
              content: h(BackingBreakdown, { backing, exposure: savingsExposure("tUSDC"), totalUsd: 50_000 }),
            },
            {
              id: "liquidity",
              title: "Liquidity",
              icon: null,
              summary: "Instant liquidity: $5K",
              content: h(LiquidityBreakdown, { amountText: "$5K", slices: [{ id: "USDC", label: "USDC", percent: 100, logo: null }] }),
            },
            { id: "simulation", title: "Simulation", icon: null, summary: null, content: h("p", null, "simulation body") },
          ],
        }),
      ),
    )
    const doc = w.document
    const row = (name: string) => [...doc.querySelectorAll("button[aria-expanded]")].find((button) => doc.getElementById(button.getAttribute("aria-labelledby")!)?.textContent === name) as HTMLButtonElement
    const panel = (name: string) => doc.getElementById(row(name).getAttribute("aria-controls")!)!
    const click = (element: Element) => act(async () => (element as HTMLElement).click())

    for (const name of ["Backing", "Liquidity", "Simulation"]) {
      assert.equal(row(name).getAttribute("aria-expanded"), "false", name)
      assert.equal(panel(name).hidden, true, name)
    }
    // The row's description is the Backing bar: its slices, each named by its label and share.
    const preview = doc.getElementById(row("Backing").getAttribute("aria-describedby")!)!
    assert.equal(preview.querySelector("button[data-bar-slice]")?.getAttribute("aria-label"), "Fidelity 40%")

    // Rows open on their own: Liquidity, then Backing, both stay open.
    await click(row("Liquidity"))
    assert.equal(row("Liquidity").getAttribute("aria-expanded"), "true")
    assert.match(panel("Liquidity").textContent!, /Instant liquidity\$5K/)
    await click(row("Backing"))
    assert.equal(row("Backing").getAttribute("aria-expanded"), "true")
    assert.equal(row("Liquidity").getAttribute("aria-expanded"), "true")
    assert.equal(panel("Backing").getAttribute("role"), "region")
    assert.equal(doc.getElementById(panel("Backing").getAttribute("aria-labelledby")!)!.textContent, "Backing")

    // By manager first; By asset type shows the backing by the kind of asset it is held in.
    const pill = (label: string) => [...panel("Backing").querySelectorAll("button[aria-pressed]")].find((button) => button.textContent === label) as HTMLButtonElement
    assert.equal(pill("By manager").getAttribute("aria-pressed"), "true")
    assert.ok(panel("Backing").querySelector('ul[aria-label="Backing assets"] [tabindex="0"]'), "the managers' tiles take focus")
    await click(pill("By asset type"))
    assert.equal(pill("By asset type").getAttribute("aria-pressed"), "true")
    assert.equal(pill("By manager").getAttribute("aria-pressed"), "false")
    const exposure = panel("Backing").querySelector('ul[aria-label="Exposure by asset type"]')!
    for (const label of ["U.S. Treasury & money market funds", "Crypto & RWA-backed loans", "USDC instant reserve"]) assert.match(exposure.textContent!, new RegExp(label.replace(/[.&]/g, "\\$&")))
    assert.equal(panel("Backing").querySelector('ul[aria-label="Backing assets"]'), null)
    await click(pill("By manager"))
    assert.ok(panel("Backing").querySelector('ul[aria-label="Backing assets"]'))

    // Closing a row leaves the others as they are.
    await click(row("Liquidity"))
    assert.equal(row("Liquidity").getAttribute("aria-expanded"), "false")
    assert.equal(panel("Liquidity").hidden, true)
    assert.equal(row("Backing").getAttribute("aria-expanded"), "true")

    await act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
