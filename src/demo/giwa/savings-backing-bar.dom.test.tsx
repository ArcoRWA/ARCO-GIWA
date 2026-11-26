// The Backing bar in React DOM: each slice a named button outside the row's own button; pointing at or focusing a
// slice emphasises it (a tip, the others faded) and highlights its tile in the open row, and a tile pointed at
// emphasises its slice on the bar; a tap picks a slice (the phone line names it) without opening or closing the row;
// Escape lets go. Gated like the other DOM tests (GIWA_HOST_DOM_RUNTIME = a jsdom package.json).

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import test from "node:test"

type AnyModule = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const runtime = process.env.GIWA_HOST_DOM_RUNTIME

test("the page hands the bar's slice to the tiles and the tiles' slice to the bar", () => {
  const page = readFileSync(new URL("./SavingsPage.tsx", import.meta.url), "utf8")
  assert.match(page, /preview: <BackingBar slices=\{backing\} tone=\{tone\} highlight=\{tileSlice\} onHighlight=\{setBarSlice\} \/>/)
  assert.match(page, /<BackingBreakdown[^>]*highlight=\{barSlice\}\s+onHighlight=\{setTileSlice\}/s)
})

test("backing bar: named slices, linked to the tiles both ways, tapped without toggling the row, Escape lets go (set GIWA_HOST_DOM_RUNTIME to an existing jsdom package.json)", { skip: !runtime }, async () => {
  const { JSDOM } = createRequire(runtime!)("jsdom")
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', { url: "http://localhost/", pretendToBeVisual: true })
  const w = dom.window
  const globals: Record<string, unknown> = {
    window: w, document: w.document, navigator: w.navigator, HTMLElement: w.HTMLElement, SVGElement: w.SVGElement,
    Element: w.Element, Node: w.Node, Event: w.Event, KeyboardEvent: w.KeyboardEvent, MouseEvent: w.MouseEvent, FocusEvent: w.FocusEvent,
    PointerEvent: w.PointerEvent, MutationObserver: w.MutationObserver, IS_REACT_ACT_ENVIRONMENT: true,
  }
  const previous = Object.fromEntries(Object.keys(globals).map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value })
  try {
    // React DOM detects its event support when first loaded, so it is loaded only once the DOM globals exist.
    const React = (await import("react")) as AnyModule
    const { createRoot } = (await import("react-dom/client")) as AnyModule
    const { SavingsAccordion } = (await import("./SavingsAccordion")) as AnyModule
    const { BackingBar, BackingBreakdown } = (await import("./SavingsBreakdown")) as AnyModule
    const { savingsBacking, savingsExposure } = (await import("./savings-backing")) as AnyModule
    const { act, createElement: h, useState } = React

    const backing = savingsBacking({ symbol: "USDC", icon: "/logos/usdc.svg" })
    // As the Savings page wires them (SavingsDetail).
    function Rows() {
      const [barSlice, setBarSlice] = useState(null)
      const [tileSlice, setTileSlice] = useState(null)
      return h(SavingsAccordion, {
        sections: [
          {
            id: "backing",
            title: "Backing",
            icon: null,
            summary: null,
            preview: h(BackingBar, { slices: backing, tone: "blue", highlight: tileSlice, onHighlight: setBarSlice }),
            content: h(BackingBreakdown, { backing, exposure: savingsExposure("tUSDC"), totalUsd: 50_000, highlight: barSlice, onHighlight: setTileSlice }),
          },
          { id: "simulation", title: "Simulation", icon: null, summary: null, content: h("p", null, "simulation body") },
        ],
      })
    }
    const root = createRoot(w.document.getElementById("root")!)
    await act(async () => root.render(h(Rows)))
    const doc = w.document
    const header = doc.querySelector('button[aria-expanded][aria-describedby]') as HTMLButtonElement
    const panel = () => doc.getElementById(header.getAttribute("aria-controls")!)!
    const segments = () => [...doc.querySelectorAll("button[data-bar-slice]")] as HTMLButtonElement[]
    const segment = (id: string) => doc.querySelector(`button[data-bar-slice="${id}"]`) as HTMLButtonElement
    const emphasis = () => Object.fromEntries(segments().map((button) => [button.dataset.barSlice, button.dataset.emphasis ?? null]))
    const faded = (id: string) => segments().every((button) => (button.dataset.barSlice === id ? button.dataset.emphasis === "on" : button.dataset.emphasis === "faded"))
    const tip = () => doc.querySelector("[data-bar-tip]") as HTMLElement | null
    const caption = () => doc.querySelector("[data-bar-caption]") as HTMLElement
    const legendFaded = () => [...doc.querySelectorAll("[data-legend-slice]")].filter((item) => item.className.includes("opacity-40")).map((item) => (item as HTMLElement).dataset.legendSlice)
    // The wide grid (the tall one is the same for phones).
    const wideTiles = () => panel().querySelectorAll('ul[aria-label="Backing assets"]')[0]!
    const tile = (name: string) => ([...wideTiles().querySelectorAll('[tabindex="0"]')] as HTMLElement[]).find((element) => element.textContent?.startsWith(name))!
    const linkedTiles = () => ([...panel().querySelectorAll('[data-linked="true"]')] as HTMLElement[]).map((element) => element.textContent)
    const cardOpen = () => panel().querySelector("[data-backing-card]") !== null
    const pointer = (type: "pointerover" | "pointerout", target: Element, pointerType: string) =>
      act(async () => {
        target.dispatchEvent(new w.PointerEvent(type, { bubbles: true, pointerType, relatedTarget: doc.body }))
      })
    const escape = () => act(async () => doc.body.dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true })))
    const click = (element: Element) => act(async () => (element as HTMLElement).click())

    // Each slice a button named by its label and share, outside the row's button (no button in a button).
    assert.deepEqual(
      segments().map((button) => button.getAttribute("aria-label")),
      ["Fidelity 40%", "UBS 20%", "Crypto & RWA-backed loans 20%", "Franklin Templeton 10%", "Instant liquidity reserve 10%"],
    )
    for (const button of segments()) assert.equal(button.closest("button[aria-expanded]") === null, true)
    assert.equal(doc.querySelectorAll("button button").length, 0)
    // The row is described by the preview: what a screen reader computes from it is the slices' names (the legend,
    // tip and phone line are hidden from it, so nothing is read twice; the legend is hidden on phones anyway).
    const preview = doc.getElementById(header.getAttribute("aria-describedby")!)!
    assert.ok(preview.contains(segments()[0]!))
    for (const hidden of preview.querySelectorAll("[data-legend-slice], [data-bar-caption]")) assert.ok(hidden.closest('[aria-hidden="true"]') !== null)
    assert.deepEqual(emphasis(), { fidelity: null, ubs: null, loans: null, "franklin-templeton": null, reserve: null })
    // Nothing picked: no line under the bar.
    assert.equal(doc.querySelector("[data-bar-caption]"), null)

    // Row closed: a mouse on UBS emphasises it (the others and their legend items fade) and shows its tip.
    await pointer("pointerover", segment("ubs"), "mouse")
    assert.ok(faded("ubs"), JSON.stringify(emphasis()))
    assert.equal(tip()?.dataset.barTip, "ubs")
    assert.equal(tip()?.getAttribute("aria-hidden"), "true")
    assert.match(tip()!.textContent!, /UBS.*20%/)
    assert.deepEqual(legendFaded(), ["fidelity", "loans", "franklin-templeton", "reserve"])
    await pointer("pointerout", segment("ubs"), "mouse")
    assert.equal(tip() === null, true)
    assert.deepEqual(legendFaded(), [])

    // Clicking the header still opens the row.
    await click(header)
    assert.equal(header.getAttribute("aria-expanded"), "true")
    assert.equal(panel().hidden, false)

    // Row open: pointing at UBS on the bar highlights UBS's tile, without opening its card.
    await pointer("pointerover", segment("ubs"), "mouse")
    assert.deepEqual(linkedTiles(), ["UBS20%", "UBS20%"])
    assert.equal(cardOpen(), false, "the bar never opens a tile's card")
    await pointer("pointerout", segment("ubs"), "mouse")
    assert.deepEqual(linkedTiles(), [])

    // The other way: pointing at Fidelity's tile emphasises Fidelity on the bar (no tip there); its card opens as before.
    await act(async () => {
      tile("Fidelity").dispatchEvent(new w.MouseEvent("mouseover", { bubbles: true, relatedTarget: doc.body }))
    })
    assert.ok(cardOpen(), "the tile's card opens as before")
    assert.equal(tile("Fidelity").dataset.active, "true")
    assert.ok(faded("fidelity"), JSON.stringify(emphasis()))
    assert.equal(tip() === null, true, "no tip from a tile")
    assert.deepEqual(legendFaded(), ["ubs", "loans", "franklin-templeton", "reserve"])
    await act(async () => {
      tile("Fidelity").dispatchEvent(new w.KeyboardEvent("keydown", { key: "Escape", bubbles: true }))
    })
    assert.equal(cardOpen(), false)
    assert.deepEqual(emphasis(), { fidelity: null, ubs: null, loans: null, "franklin-templeton": null, reserve: null })
    // Keyboard focus on a tile does the same.
    await act(async () => tile("UBS").focus())
    assert.ok(faded("ubs"))
    await act(async () => tile("UBS").blur())
    assert.deepEqual(legendFaded(), [])

    // Keyboard focus on a slice: emphasised, its tip, its tile highlighted; Escape lets go.
    await act(async () => segment("loans").focus())
    assert.ok(faded("loans"))
    assert.equal(tip()?.dataset.barTip, "loans")
    assert.deepEqual(linkedTiles(), ["Crypto & RWA-backed loans20%", "Crypto & RWA-backed loans20%"])
    await escape()
    assert.equal(tip() === null, true)
    assert.deepEqual(linkedTiles(), [])
    await act(async () => segment("loans").blur())

    // A tap (a touch: no hover) picks a slice: the others fade, the phone line names it, its tile is highlighted, the
    // row stays open. A tap on another moves the pick; a tap on the picked one lets go.
    await pointer("pointerover", segment("franklin-templeton"), "touch")
    assert.equal(tip() === null, true, "a touch does not hover")
    await click(segment("franklin-templeton"))
    assert.equal(header.getAttribute("aria-expanded"), "true", "a tap on the bar does not toggle the row")
    assert.equal(segment("franklin-templeton").getAttribute("aria-pressed"), "true")
    assert.ok(faded("franklin-templeton"))
    assert.equal(caption().dataset.barCaption, "franklin-templeton")
    assert.equal(caption().textContent, "Franklin Templeton10%")
    assert.equal(caption().getAttribute("aria-hidden"), "true")
    assert.deepEqual(linkedTiles(), ["Franklin Templeton10%", "Franklin Templeton10%"])
    await click(segment("reserve"))
    assert.equal(segment("franklin-templeton").getAttribute("aria-pressed"), "false")
    assert.equal(segment("reserve").getAttribute("aria-pressed"), "true")
    assert.equal(caption().textContent, "Instant liquidity reserve10%")
    await click(segment("reserve"))
    assert.equal(segment("reserve").getAttribute("aria-pressed"), "false")
    assert.equal(doc.querySelector("[data-bar-caption]"), null)
    assert.deepEqual(linkedTiles(), [])

    // Escape lets go of a pick too.
    await click(segment("fidelity"))
    assert.equal(caption().dataset.barCaption, "fidelity")
    await escape()
    assert.equal(doc.querySelector("[data-bar-caption]"), null)
    assert.equal(segment("fidelity").getAttribute("aria-pressed"), "false")
    assert.deepEqual(emphasis(), { fidelity: null, ubs: null, loans: null, "franklin-templeton": null, reserve: null })

    // By asset type: the tiles' ids that match the bar's (the loans, the reserve) highlight; the funds' slices have no tile.
    const pill = (label: string) => [...panel().querySelectorAll("button[aria-pressed]")].find((button) => button.textContent === label) as HTMLButtonElement
    await click(pill("By asset type"))
    await click(segment("fidelity"))
    assert.deepEqual(linkedTiles(), [])
    await click(segment("loans"))
    assert.deepEqual(linkedTiles(), ["Crypto & RWA-backed loans20%", "Crypto & RWA-backed loans20%"])
    await escape()

    // A picked slice stays when the row closes; clicking the header closes it as before.
    await click(segment("ubs"))
    await click(header)
    assert.equal(header.getAttribute("aria-expanded"), "false")
    assert.equal(panel().hidden, true)
    assert.equal(segment("ubs").getAttribute("aria-pressed"), "true")

    await act(async () => root.unmount())
  } finally {
    for (const [key, descriptor] of Object.entries(previous)) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor)
      else delete (globalThis as Record<string, unknown>)[key]
    }
  }
})
