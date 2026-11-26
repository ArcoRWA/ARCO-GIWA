import assert from "node:assert/strict"
import test from "node:test"
import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { GiwaBottomTabBar, GiwaNavRail } from "./GiwaNavRail"
import { INVESTOR_NAV_ITEMS, investorNavItems, isNavItemActive, type InvestorNavItemId } from "./investor-nav"
import { GIWA_FUNDS_ROUTE } from "./routes"
import { GIWA_FEATURES, GiwaFeaturesContext, type GiwaFeatures } from "./features"

// Every section shown; the app's own switch (features.ts) is tested on its own below.
const ALL: GiwaFeatures = { home: true, stocks: true }

const shape = (isAdmin: boolean, features: GiwaFeatures = ALL) => investorNavItems(isAdmin, features).map((item) => [item.label, item.to])

function activeIds(pathname: string, isAdmin = true): InvestorNavItemId[] {
  return investorNavItems(isAdmin, ALL)
    .filter((item) => isNavItemActive(item, pathname))
    .map((item) => item.id)
}

function render(path: string, options: { features?: GiwaFeatures; isAdmin?: boolean } = {}) {
  return renderToStaticMarkup(
    <GiwaFeaturesContext.Provider value={options.features ?? GIWA_FEATURES}>
      <MemoryRouter initialEntries={[path]}>
        <GiwaNavRail isAdmin={options.isAdmin ?? false} />
        <GiwaBottomTabBar />
      </MemoryRouter>
    </GiwaFeaturesContext.Provider>,
  )
}
const railOf = (html: string) => html.slice(html.indexOf("<aside"), html.indexOf("</aside>"))
const barOf = (html: string) => html.slice(html.indexOf('<nav aria-label="Tab bar"'))
const labels = (scope: string) => [...scope.matchAll(/<a [^>]*href="([^"]+)"[^>]*>(?:<svg[^]*?<\/svg>|<span[^>]*>[^]*?<\/span>)(?:<span class="max-w-full truncate px-0.5">)?([^<]+)(?:<\/span>)?<\/a>/g)].map((match) => [match[2], match[1]])

test("the tabs keep their order, labels and routes", () => {
  assert.equal(GIWA_FUNDS_ROUTE, "/funds")
  assert.deepEqual(shape(false), [["Home", "/home"], ["Savings", "/savings"], ["Funds", "/funds"], ["Stocks", "/stocks"], ["Portfolio", "/portfolio"]])
})

test("hidden sections leave the tabs (the app hides Home and Stocks now); Admin comes last for allowlisted wallets", () => {
  assert.deepEqual(GIWA_FEATURES, { home: false, stocks: false })
  assert.deepEqual(shape(false, GIWA_FEATURES), [["Savings", "/savings"], ["Funds", "/funds"], ["Portfolio", "/portfolio"]])
  assert.deepEqual(investorNavItems(false), investorNavItems(false, GIWA_FEATURES))
  assert.deepEqual(shape(true, GIWA_FEATURES), [["Savings", "/savings"], ["Funds", "/funds"], ["Portfolio", "/portfolio"], ["Admin", "/admin"]])
  assert.deepEqual(shape(false, { home: true, stocks: false })[0], ["Home", "/home"])
  assert.deepEqual(shape(true)[shape(true).length - 1], ["Admin", "/admin"])
  // The shared constant is never mutated by the admin variant.
  assert.equal(INVESTOR_NAV_ITEMS.length, 5)
  for (const admin of [false, true]) assert.ok(!investorNavItems(admin).some((item) => item.id === "send"), "Send stays out until it exists")
})

test("active matching per path", () => {
  const cases: Array<[string, InvestorNavItemId[]]> = [
    ["/home", ["home"]],
    // The root redirects to Savings; nothing is current on the way.
    ["/", []],
    ["/funds", ["funds"]],
    ["/product/abc", ["funds"]],
    ["/savings", ["savings"]],
    ["/stocks", ["stocks"]],
    ["/admin/stocks", ["stocks"]],
    ["/portfolio", ["portfolio"]],
    ["/admin/operations", ["admin"]],
    ["/admin", ["admin"]],
    ["/stocks/", ["stocks"]],
    ["/unknown", []],
  ]
  for (const [pathname, expected] of cases) assert.deepEqual(activeIds(pathname), expected, pathname)
  for (const pathname of ["/", "/funds", "/savings", "/stocks", "/portfolio", "/admin", "/send"]) {
    assert.equal(isNavItemActive({ id: "send" }, pathname), false, pathname)
  }
})

test("rail: the tabs per feature flags and allowlist, as icon-over-label links", () => {
  const shipped = railOf(render("/savings"))
  assert.deepEqual(labels(shipped.slice(shipped.indexOf('<nav aria-label="Main"'))).filter(([, href]) => !href.includes("?")), [["Savings", "/savings"], ["Funds", "/funds"], ["Portfolio", "/portfolio"]])
  assert.doesNotMatch(shipped, /href="\/home"|href="\/stocks"|href="\/admin"|href="\/send"/)
  const all = railOf(render("/savings", { features: ALL, isAdmin: true }))
  assert.deepEqual(
    labels(all.slice(all.indexOf('<nav aria-label="Main"'))).filter(([, href]) => !href.includes("?")),
    [["Home", "/home"], ["Savings", "/savings"], ["Funds", "/funds"], ["Stocks", "/stocks"], ["Portfolio", "/portfolio"], ["Admin", "/admin"]],
  )
  // No 224px sidebar, collapse button or section captions any more.
  assert.match(all, /w-\[92px\]/)
  assert.doesNotMatch(all, /Collapse sidebar|Expand sidebar|>Invest<|>Manage</)
  // The logo links where it always has: the root.
  assert.match(all, /<a aria-label="Arco home"[^>]*href="\/"/)
})

test("rail and tab bar: exactly one current page, the filled icon and the pill on it", () => {
  const cases: Array<[string, string]> = [["/funds", "Funds"], ["/product/abc", "Funds"], ["/savings", "Savings"], ["/portfolio", "Portfolio"], ["/admin/operations", "Admin"]]
  for (const [path, label] of cases) {
    const html = render(path, { isAdmin: true })
    const rail = railOf(html)
    const current = [...rail.matchAll(/<a aria-current="page"[^>]*>[^]*?<\/svg>([^<]+)<\/a>/g)].map((match) => match[1])
    assert.deepEqual(current, [label], path)
    assert.match(rail, /<a aria-current="page"[^>]*class="[^"]*bg-\[var\(--color-arco-chip\)\] font-semibold/, path)
    assert.match(rail, /<a aria-current="page"[^>]*><svg[^>]*fill="currentColor"/, path)
    // Admin is not in the tab bar (it is in the phone menu).
    const bar = barOf(html)
    assert.equal(bar.match(/aria-current="page"/g)?.length ?? 0, label === "Admin" ? 0 : 1, path)
  }
  // Inactive tabs: muted, no pill, outline icon.
  const rail = railOf(render("/funds"))
  assert.match(rail, /<a class="[^"]*text-\[var\(--color-arco-muted-text\)\][^"]*" href="\/portfolio"/)
  assert.match(rail, /<a [^>]*href="\/portfolio"[^>]*><svg[^>]*fill="none"/)
})

test("rail utilities: Documentation and Terms of Use, icon-only with names and tooltips (Mint test assets comes from the shell)", () => {
  const rail = railOf(render("/funds"))
  assert.match(rail, /<a href="#" aria-label="Documentation"[^>]*>[^]*?aria-hidden="true"[^>]*>Documentation<\/span><\/a>/)
  assert.match(rail, /<a href="#" aria-label="Terms of Use"[^>]*>[^]*?aria-hidden="true"[^>]*>Terms of Use<\/span><\/a>/)
  assert.ok(rail.indexOf('aria-label="Documentation"') < rail.indexOf('aria-label="Terms of Use"'))
})

test("tab bar: Savings, Funds, Portfolio below xl only, with its own name, the safe area and no Admin", () => {
  const bar = barOf(render("/portfolio", { isAdmin: true }))
  assert.match(bar, /^<nav aria-label="Tab bar" class="fixed inset-x-0 bottom-0 z-40 [^"]*xl:hidden" style="padding-bottom:env\(safe-area-inset-bottom\)"/)
  assert.deepEqual(labels(bar), [["Savings", "/savings"], ["Funds", "/funds"], ["Portfolio", "/portfolio"]])
  // The rail is the xl one.
  assert.match(railOf(render("/portfolio")), /^<aside class="fixed inset-y-0 left-0 z-30 hidden w-\[92px\][^"]*xl:flex"/)
})
