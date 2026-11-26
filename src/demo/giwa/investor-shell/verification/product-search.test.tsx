import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import snapshot from "./deployed-giwa.snapshot.json"
import type { GiwaMarketEntry } from "../../api"
import type { ArcoGoldLive } from "../../arcogold-live"
import type { ArcoUsdLive } from "../../arcousd-live"
import { FUNDS_LINEUP, type LineupFund } from "../../funds-lineup"
import {
  categoryItems, FUNDS_PREVIEW, fundItems, highlightParts, opensPalette, pageItems, paletteActions, paletteSections, savingsItems,
  SEARCH_SHORTCUT_KEY, stockItems, type PaletteItem,
} from "../../product-search"
import { SAVINGS_CATEGORIES } from "../../savings-category"
import { savingsOffers, savingsPageAccounts } from "../../savings-page-accounts"
import { fixtureTop40Catalog, fixtureTop40Quotes } from "../../stocks-market/fixtures"
import type { GiwaCatalogItem } from "../../types"

// The catalog as production has it: the arcoUSD vault hidden (sArcoUSD takes its place on the live contracts), the
// Crypto vaults' tokens named arcoBTC (offering BTC) and arcoXRP; the market with the server's set rates for the Crypto
// vaults (aBTC 2.79%, aXRP 4.57%); a coming-soon SOL coin on the aXRP vault.
const catalog = (snapshot.catalog as unknown as GiwaCatalogItem[]).map((product) => {
  const config = product.vaultConfig!
  if (product.productId === "arcousd") return { ...product, vaultConfig: { ...config, hidden: true } }
  if (product.productId === "abtc") return { ...product, symbol: "arcoBTC", vaultConfig: { ...config, hidden: false, acceptAssets: [{ symbol: "BTC", savingVaultId: "abtc", isDummy: false }] } }
  if (product.productId === "axrp") return { ...product, symbol: "arcoXRP", vaultConfig: { ...config, acceptAssets: [...(config.acceptAssets ?? []), { symbol: "SOL", savingVaultId: null, isDummy: true, apy: 6 }] } }
  return product
}) as unknown as GiwaCatalogItem[]
const market: GiwaMarketEntry[] = [
  ...snapshot.market.filter((entry) => entry.productId !== "abtc" && entry.productId !== "axrp"),
  { productId: "abtc", navBase: 1.0123, baseUsd: 92_000, navUsd: 92_000 * 1.0123, apy: 2.79, impliedApy: 41.2 },
  { productId: "axrp", navBase: 1.0238, baseUsd: 2.35, navUsd: 2.35 * 1.0238, apy: 4.57, impliedApy: null },
]
const live = {
  arcoUSD: "0x3d6Cb251d6aA62591ce9f6a13781a6dC590411Da", reserve: "0x4942711396B53df5b02fD8065E77FA2c9D27512F", depositPaused: false, redeemPaused: false,
  assets: [{
    option: { key: "usdc-giwa", symbol: "USDC", name: "USD Coin", logo: "/logos/usdc.png", decimals: 6, chain: "giwa", chainName: "GIWA" },
    token: "0x1111111111111111111111111111111111111111", symbol: "tUSDC", decimals: 6, depositEnabled: true, redeemEnabled: true, swapFeeBps: 0, instantFeeBps: 0, available: 0,
  }],
  savings: { sArcoUSD: "0xcAEF04FeA7f9c2561dbCA95E39a6b06043df30Fd", zap: "0xf4554ea97218645cF2EB209Cd540BD91321ba1E1", sharePrice: 1.02, apyPercent: 4, paidApyPercent: 4, depositsOpen: true, withdrawalsOpen: true },
} as unknown as ArcoUsdLive
const gold = {
  arcoGOLD: "0xCfBB1da2040Bd559B2d7a96F818494d922Fb1860", zap: "0x6C67403808DCDA693e5B9f2ddF543659FF3f27B4", sharePrice: 1, ounceUsd: 2400, apyPercent: 3.1,
  depositPaused: false, redeemPaused: false, depositsOpen: true, withdrawalsOpen: true,
  coins: [{
    option: { key: "paxg-giwa", symbol: "PAXG", name: "PAX Gold", logo: "/logos/paxg.png", decimals: 18, chain: "giwa", chainName: "GIWA" },
    token: "0x6666666666666666666666666666666666666666", symbol: "tPAXG", decimals: 18, depositEnabled: true, redeemEnabled: true, swapFeeBps: 0, instantFeeBps: 0, available: 0,
  }],
} as unknown as ArcoGoldLive

const offers = (input: { live?: ArcoUsdLive | null; gold?: ArcoGoldLive | null } = {}) =>
  savingsOffers(savingsPageAccounts({ catalog, market, live: input.live === undefined ? live : input.live, gold: input.gold === undefined ? gold : input.gold }))
// Seven funds, to see "Show all": the lineup and four more of its entries under other ids.
const sevenFunds: LineupFund[] = [...FUNDS_LINEUP, ...FUNDS_LINEUP.slice(0, 3).map((entry, i) => ({ ...entry, fund: { ...entry.fund, id: `${entry.fund.id}-${i}`, symbol: `${entry.fund.symbol}${i}` } })), { ...FUNDS_LINEUP[0]!, fund: { ...FUNDS_LINEUP[0]!.fund, id: "extra", symbol: "EXTRA" } }]
const inputs = (over: Partial<Parameters<typeof paletteSections>[0]> = {}) => ({
  savings: savingsItems(offers()),
  funds: fundItems(FUNDS_LINEUP),
  stocks: [] as PaletteItem[],
  pages: pageItems(SAVINGS_CATEGORIES),
  categories: categoryItems(SAVINGS_CATEGORIES),
  actions: paletteActions({ convert: true }),
  query: "",
  fundsExpanded: false,
  ...over,
})
const titles = (result: ReturnType<typeof paletteSections>) => result.sections.map((section) => [section.id, section.items.map((item) => item.title)])

test("Savings: the accounts the Savings page offers, named and rated as it shows them, opening it as its tabs do", () => {
  const savings = savingsItems(offers())
  assert.deepEqual(savings.map((p) => [p.title, p.subtitle, p.value, p.valueLabel]).sort(), [
    ["ArcoGOLD", "Savings · Gold", "3.1%", "APY"],
    ["aETH", "Savings · Crypto", "3.86%", "APY"],
    ["arcoBTC", "Savings · Crypto", "2.79%", "APY"],
    ["arcoXRP", "Savings · Crypto", "4.57%", "APY"],
    ["sArcoUSD", "Savings · Stablecoins", "4%", "APY"],
  ])
  const at = (title: string) => savings.find((p) => p.title === title)!
  assert.deepEqual(at("sArcoUSD").target, { kind: "link", href: "/savings?category=stablecoins&asset=USDC&account=real%3Aarcousd%3AUSDC" })
  assert.deepEqual(at("arcoBTC").target, { kind: "link", href: "/savings?category=crypto-native&asset=BTC&account=real%3Aabtc%3ABTC" })
  assert.deepEqual(at("ArcoGOLD").target, { kind: "link", href: "/savings?category=gold&asset=PAXG&account=real%3Aarcogold%3APAXG" })
  assert.ok(savings.every((p) => p.image), "every account has its mark")
  assert.ok(!savings.some((p) => /SOL|—/.test(`${p.title} ${p.value}`)), "the coming-soon coin is not offered, so not listed")
  // Gold only while the live gold account is up; without live ArcoUSD the stablecoin account is the arcoUSD vault.
  assert.ok(!savingsItems(offers({ gold: null })).some((p) => p.title === "ArcoGOLD"))
  const stable = savingsItems(offers({ live: null })).find((p) => p.subtitle === "Savings · Stablecoins")!
  assert.deepEqual([stable.id, stable.title, stable.value], ["savings:arcousd", "sArcoUSD", "4.79%"])
})

test("search and the Savings and Funds pages derive from the same functions (no second list)", () => {
  const accounts = savingsPageAccounts({ catalog, market, live, gold })
  for (const offer of offers()) assert.equal(offer.apy, accounts.find((account) => account.key === offer.account.key)!.apy, offer.symbol)
  const source = (file: string) => readFileSync(new URL(`../../${file}`, import.meta.url), "utf8")
  assert.match(source("SavingsPage.tsx"), /savingsPageAccounts\(\{ catalog: catalogQuery\.data \?\? \[\], market: marketQuery\.data \?\? \[\], live, gold \}\)/)
  assert.match(source("GiwaProductSearch.tsx"), /savingsItems\(savingsOffers\(savingsPageAccounts\(/)
  assert.match(source("Investor.tsx"), /<FundsList funds=\{FUNDS_LINEUP\} \/>/)
  assert.match(source("GiwaProductSearch.tsx"), /fundItems\(FUNDS_LINEUP\)/)
})

test("Funds: the Funds page's lineup, with its names, marks and the table's yield text", () => {
  const funds = fundItems(FUNDS_LINEUP)
  assert.deepEqual(funds.map((p) => [p.title, p.note, p.subtitle, p.value, p.valueLabel, p.target]), FUNDS_LINEUP.map(({ fund }) => [fund.symbol, fund.name, "Fund", fund.metric.value, fund.metric.label, { kind: "link", href: `/product/${fund.id}` }]))
  assert.deepEqual(funds.map((p) => `${p.value} ${p.valueLabel}`), ["7% Target APY", "39.66% 12-month return", "12.53% 30-day avg. APY"])
  assert.ok(funds.every((p) => p.image))
})

test("sections: Savings, Funds, Pages, Actions in order; counts on products, and on pages and actions while filtering", () => {
  const all = paletteSections(inputs())
  assert.deepEqual(all.sections.map((s) => [s.id, s.label, s.total, s.counted]), [["savings", "Savings", 5, true], ["funds", "Funds", 3, true], ["pages", "Pages", 3, false], ["actions", "Actions", 3, false]])
  assert.equal(all.empty, false)
  assert.deepEqual(titles(all).slice(2), [["pages", ["Savings", "Funds", "Portfolio"]], ["actions", ["Convert", "Documentation", "Terms of Use"]]])
  assert.equal(all.sections[2]!.items[0]!.subtitle, "Stablecoins · Crypto · Gold")
  // Stocks, when shown, after Funds.
  const withStocks = paletteSections(inputs({ stocks: stockItems(fixtureTop40Catalog().securities, fixtureTop40Quotes()) }))
  assert.deepEqual(withStocks.sections.map((s) => s.id), ["savings", "funds", "stocks", "pages", "actions"])
  assert.equal(withStocks.sections[2]!.total, 40)
  // No converters: no Convert. Docs and Terms open elsewhere.
  assert.deepEqual(paletteActions({ convert: false }).map((a) => a.title), ["Documentation", "Terms of Use"])
  assert.ok(paletteActions({ convert: false }).every((a) => a.target.kind === "external"))
  assert.deepEqual(paletteActions({ convert: true })[0]!.target, { kind: "action", action: "convert" })
})

test(`funds: the first ${FUNDS_PREVIEW}, then "Show all" lists the rest in place`, () => {
  const short = paletteSections(inputs({ funds: fundItems(sevenFunds) }))
  const funds = short.sections.find((s) => s.id === "funds")!
  assert.deepEqual([funds.items.length, funds.total, funds.hidden], [5, 7, 2])
  const long = paletteSections(inputs({ funds: fundItems(sevenFunds), fundsExpanded: true })).sections.find((s) => s.id === "funds")!
  assert.deepEqual([long.items.length, long.total, long.hidden], [7, 7, 0])
  assert.equal(paletteSections(inputs()).sections.find((s) => s.id === "funds")!.hidden, 0, "three funds: no Show all")
})

test("filtering: across every section, by symbol, name, coins, category, manager, Korean words, pages and actions", () => {
  const find = (query: string, over: Partial<Parameters<typeof paletteSections>[0]> = {}) => titles(paletteSections(inputs({ query, ...over })))
  assert.deepEqual(find("gold"), [["savings", ["ArcoGOLD"]], ["pages", ["Savings › Gold"]]])
  assert.deepEqual(find("stable"), [["savings", ["sArcoUSD"]], ["pages", ["Savings › Stablecoins"]], ["actions", ["Convert"]]])
  assert.deepEqual(find("usdc"), [["savings", ["sArcoUSD"]]])
  assert.deepEqual(find("crypto"), [["savings", ["aETH", "arcoXRP", "arcoBTC"]], ["pages", ["Savings › Crypto"]]])
  assert.deepEqual(find("bitwise"), [["funds", ["PPLUS"]]])
  assert.deepEqual(find("credit"), [["funds", ["HOME", "PPLUS"]]])
  assert.deepEqual(find("펀드"), [["funds", ["HOME", "JX", "PPLUS"]], ["pages", ["Funds"]]])
  assert.deepEqual(find("portfolio"), [["pages", ["Portfolio"]]])
  assert.deepEqual(find("convert"), [["actions", ["Convert"]]])
  assert.deepEqual(find("docs"), [["actions", ["Documentation"]]])
  assert.deepEqual(find("  tEsLa  ", { stocks: stockItems(fixtureTop40Catalog().securities) }), [["stocks", ["TSLA"]]])
  // Counts while filtering: on every listed section.
  assert.ok(paletteSections(inputs({ query: "gold" })).sections.every((s) => s.counted))
  // The category pages appear only when the query names them.
  assert.ok(!titles(paletteSections(inputs())).flat(2).includes("Savings › Gold"))
  // Hidden Gold category (no live gold): no gold account and no gold page either, so nothing matches.
  const noGold = paletteSections(inputs({ query: "gold", savings: savingsItems(offers({ gold: null })), categories: categoryItems(SAVINGS_CATEGORIES.filter((c) => c.id !== "gold")) }))
  assert.equal(noGold.empty, true)
  assert.ok(!titles(noGold).flat(2).some((title) => /gold/i.test(String(title))))
})

test("no results: the message, and the pages and actions listed whole below it", () => {
  const none = paletteSections(inputs({ query: "xyz" }))
  assert.equal(none.empty, true)
  assert.deepEqual(titles(none), [["pages", ["Savings", "Funds", "Portfolio"]], ["actions", ["Convert", "Documentation", "Terms of Use"]]])
  assert.ok(none.sections.every((s) => !s.counted))
})

test("bolding: the query's words where they occur, any case", () => {
  assert.deepEqual(highlightParts("ArcoGOLD", "gold"), [{ text: "Arco", match: false }, { text: "GOLD", match: true }])
  assert.deepEqual(highlightParts("Savings › Gold", "gold"), [{ text: "Savings › ", match: false }, { text: "Gold", match: true }])
  assert.deepEqual(highlightParts("Bitwise Premium+ RWA Vault", "rwa prem"), [{ text: "Bitwise ", match: false }, { text: "Prem", match: true }, { text: "ium+ ", match: false }, { text: "RWA", match: true }, { text: " Vault", match: false }])
  assert.deepEqual(highlightParts("a+b", "+"), [{ text: "a", match: false }, { text: "+", match: true }, { text: "b", match: false }], "regex characters are matched as text")
  assert.deepEqual(highlightParts("HOME", ""), [{ text: "HOME", match: false }])
})

test(`shortcut: "${SEARCH_SHORTCUT_KEY}" alone, never in a field or a dialog; no ⌘ / Ctrl shortcut`, () => {
  assert.equal(SEARCH_SHORTCUT_KEY, "/")
  const key = (over: Partial<KeyboardEvent> = {}) => ({ key: "/", ctrlKey: false, metaKey: false, altKey: false, ...over })
  const el = (closest: string | null) => ({ closest: (selector: string) => (closest !== null && selector.includes(closest) ? {} : null) }) as unknown as Element
  assert.equal(opensPalette(key(), null), true)
  assert.equal(opensPalette(key(), el(null)), true)
  for (const field of ["input", "textarea", "select", "[contenteditable=true]", "[role=dialog]"]) assert.equal(opensPalette(key(), el(field)), false, field)
  for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) assert.equal(opensPalette(key({ [modifier]: true }), null), false, modifier)
  for (const other of ["k", "a", "K", "?"]) {
    assert.equal(opensPalette(key({ key: other }), null), false, other)
    assert.equal(opensPalette(key({ key: other, metaKey: true }), null), false, `⌘${other}`)
    assert.equal(opensPalette(key({ key: other, ctrlKey: true }), null), false, `Ctrl ${other}`)
  }
})

test("stocks: missing or stale quotes do not invent prices", () => {
  const stocks = stockItems(fixtureTop40Catalog().securities, fixtureTop40Quotes())
  assert.equal(stocks.find((p) => p.title === "SGOV")?.value, "—")
  assert.equal(stocks.find((p) => p.title === "SCHD")?.change, undefined)
  assert.deepEqual(stocks.find((p) => p.title === "SOXL")?.target, { kind: "link", href: "/stocks?symbol=SOXL" })
})
