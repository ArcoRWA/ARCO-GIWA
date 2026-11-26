// The search palette's contents: exactly what the app offers, from the sources its pages use (no list of its own),
// plus the app's pages and a few actions.
//   • Savings: the accounts the Savings page offers (savings-page-accounts.ts: the Vault Config's, with sArcoUSD and
//     ArcoGOLD in their places when live), one per account as the Savings card names it, at the APY its tab shows,
//     opening the page on it as its tab does.
//   • Funds: the Funds page's lineup (funds-lineup.ts), with the name, mark and yield its table shows.
//   • Stocks: the stocks market's catalog and quotes, while features.ts shows Stocks.
//   • Pages: Savings, Funds, Portfolio; a Savings category ("Savings › Gold") only when the query names it.
//   • Actions: `paletteActions` (Convert where the shell has converters, then the footer's Documentation and Terms).
// Every row has its words (`keywords`); a query matches a row when each of its words is in them.
import { FUNDS_TABS, type LineupFund } from "./funds-lineup"
import { fundMarkSrc } from "./FundMark"
import { GIWA_FOOTER_LINKS } from "./footer-links"
import { giwaProductPath, GIWA_FUNDS_ROUTE, GIWA_PORTFOLIO_ROUTE, GIWA_SAVINGS_ROUTE, GIWA_STOCKS_ROUTE } from "./routes"
import { savingsCategoryPath, type SavingsCategory } from "./savings-category"
import type { SavingsOffer } from "./savings-page-accounts"
import { stockLogoPath } from "./stocks-market/curated"
import type { Quote, Security } from "./stocks-market/contracts"

/** The key that opens the palette from anywhere but a field or a dialog. */
export const SEARCH_SHORTCUT_KEY = "/"
/** How many funds show before "Show all N funds". */
export const FUNDS_PREVIEW = 5

export type PaletteSectionId = "savings" | "funds" | "stocks" | "pages" | "actions"
export type PaletteIcon = "savings" | "funds" | "portfolio" | "convert" | "docs" | "terms"
/** What a row does: open a page of the app, open a page elsewhere (a new tab), or run one of the shell's actions. */
export type PaletteTarget =
  | Readonly<{ kind: "link"; href: string }>
  | Readonly<{ kind: "external"; href: string }>
  | Readonly<{ kind: "action"; action: PaletteActionId }>
export type PaletteActionId = "convert"

export type PaletteItem = Readonly<{
  id: string
  section: PaletteSectionId
  title: string
  /** After the title, softer ("· NUVA HOME Vault"). */
  note?: string
  subtitle?: string
  /** The figure on the right and the line under it ("4%" over "APY", "7%" over "Target APY"). */
  value?: string
  valueLabel?: string
  /** A stock's day change, signed. */
  change?: string
  negative?: boolean
  image?: string
  icon?: PaletteIcon
  target: PaletteTarget
  keywords: string
}>

export function savingsItems(offers: readonly SavingsOffer[]): PaletteItem[] {
  return offers.map((offer) => ({
    id: `savings:${offer.vault.productId}`,
    section: "savings",
    title: offer.symbol,
    subtitle: `Savings · ${offer.categoryLabel}`,
    value: offer.apy,
    valueLabel: "APY",
    image: offer.image,
    target: { kind: "link", href: offer.href },
    // Its category's words ("stablecoins", "crypto", "gold") and the coins it takes match too.
    keywords: `${offer.symbol} ${offer.vault.name} ${offer.coins.join(" ")} ${offer.categoryLabel} ${offer.category} savings 저축`,
  }))
}

export function fundItems(funds: readonly LineupFund[]): PaletteItem[] {
  return funds.map(({ fund, tab, type }) => ({
    id: `fund:${fund.id}`,
    section: "funds",
    title: fund.symbol,
    note: fund.name,
    subtitle: "Fund",
    value: fund.metric.value,
    valueLabel: fund.metric.label,
    image: fundMarkSrc(fund.symbol),
    target: { kind: "link", href: giwaProductPath(fund.id) },
    keywords: `${fund.id} ${fund.symbol} ${fund.name} ${type} ${FUNDS_TABS.find((entry) => entry.id === tab)?.label ?? ""} ${fund.manager.name} ${fund.issuer.name} ${fund.underlying} fund funds 펀드`,
  }))
}

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 })
export function stockItems(stocks: readonly Security[], quotes: readonly Quote[] = []): PaletteItem[] {
  const prices = new Map(quotes.map((quote) => [quote.symbol, quote]))
  return stocks.map((stock) => {
    const quote = prices.get(stock.symbol)
    const available = quote?.status === "AVAILABLE"
    const change = available && quote.changePercent != null ? Number(quote.changePercent) : null
    return {
      id: `stock:${stock.symbol}`,
      section: "stocks",
      title: stock.symbol,
      subtitle: stock.name,
      value: available && quote.price != null ? `$${number.format(Number(quote.price))}` : "—",
      change: change == null ? undefined : `${change > 0 ? "+" : ""}${number.format(change)}%`,
      negative: change != null && change < 0,
      image: stockLogoPath(stock.symbol) ?? undefined,
      target: { kind: "link", href: `${GIWA_STOCKS_ROUTE}?symbol=${encodeURIComponent(stock.symbol)}` },
      keywords: `${stock.symbol} ${stock.name} ${stock.isin ?? ""} stocks 주식 ETF`,
    }
  })
}

/** The app's pages; the Savings page names the categories it has (Gold only while the live gold account is). */
export function pageItems(categories: readonly Readonly<{ id: SavingsCategory; label: string }>[]): PaletteItem[] {
  return [
    { id: "page:savings", section: "pages", title: "Savings", subtitle: categories.map((category) => category.label).join(" · "), icon: "savings", target: { kind: "link", href: GIWA_SAVINGS_ROUTE }, keywords: "savings page 저축" },
    { id: "page:funds", section: "pages", title: "Funds", subtitle: "Tokenized funds", icon: "funds", target: { kind: "link", href: GIWA_FUNDS_ROUTE }, keywords: "funds tokenized page 펀드" },
    { id: "page:portfolio", section: "pages", title: "Portfolio", subtitle: "Your holdings and earnings", icon: "portfolio", target: { kind: "link", href: GIWA_PORTFOLIO_ROUTE }, keywords: "portfolio holdings earnings page 포트폴리오" },
  ]
}

/** "Savings › Gold": listed only when the query names the category. */
export function categoryItems(categories: readonly Readonly<{ id: SavingsCategory; label: string }>[]): PaletteItem[] {
  return categories.map((category) => ({
    id: `page:savings:${category.id}`,
    section: "pages",
    title: `Savings › ${category.label}`,
    subtitle: "Savings category",
    icon: "savings",
    target: { kind: "link", href: savingsCategoryPath(category.id) },
    keywords: `${category.label} ${category.id}`,
  }))
}

/** The palette's actions, in order. A new action (Mint test assets) is one more entry here. */
export function paletteActions(input: { convert: boolean }): PaletteItem[] {
  const docs = GIWA_FOOTER_LINKS.find((link) => link.label === "Documentation")
  const terms = GIWA_FOOTER_LINKS.find((link) => link.label === "Terms of Use")
  return [
    ...(input.convert
      ? [{ id: "action:convert", section: "actions" as const, title: "Convert", subtitle: "Swap stablecoins and ArcoUSD", icon: "convert" as const, target: { kind: "action" as const, action: "convert" as const }, keywords: "convert swap stablecoins arcousd" }]
      : []),
    ...(docs ? [{ id: "action:docs", section: "actions" as const, title: docs.label, icon: "docs" as const, target: { kind: "external" as const, href: docs.href }, keywords: "documentation docs help" }] : []),
    ...(terms ? [{ id: "action:terms", section: "actions" as const, title: terms.label, icon: "terms" as const, target: { kind: "external" as const, href: terms.href }, keywords: "terms of use legal" }] : []),
  ]
}

const SECTION_LABEL: Record<PaletteSectionId, string> = { savings: "Savings", funds: "Funds", stocks: "Stocks", pages: "Pages", actions: "Actions" }
const PRODUCT_SECTIONS: readonly PaletteSectionId[] = ["savings", "funds", "stocks"]

export type PaletteSection = Readonly<{
  id: PaletteSectionId
  label: string
  items: readonly PaletteItem[]
  /** How many rows match (the funds past the preview included). */
  total: number
  /** Funds left out until "Show all"; 0 for any other section. */
  hidden: number
  /** Whether the caption shows its count: products always, pages and actions while filtering. */
  counted: boolean
}>

export function queryWords(query: string): string[] {
  return query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean)
}

/** A row matches when each word is in its title, its note or its keywords (not its subtitle: the Savings page's
 * "Stablecoins · Crypto · Gold" should not answer "gold"). */
export function matchesQuery(item: Pick<PaletteItem, "title" | "note" | "keywords">, words: readonly string[]): boolean {
  const text = `${item.title} ${item.note ?? ""} ${item.keywords}`.toLocaleLowerCase()
  return words.every((word) => text.includes(word))
}

/**
 * The palette's sections for a query, in order (Savings, Funds, Stocks, Pages, Actions), empty ones left out. With a
 * query nothing matches, `empty` is true and the pages and actions are listed whole below the message.
 */
export function paletteSections(input: {
  savings: readonly PaletteItem[]
  funds: readonly PaletteItem[]
  stocks: readonly PaletteItem[]
  pages: readonly PaletteItem[]
  categories: readonly PaletteItem[]
  actions: readonly PaletteItem[]
  query: string
  fundsExpanded: boolean
}): { sections: PaletteSection[]; empty: boolean } {
  const words = queryWords(input.query)
  const filtering = words.length > 0
  const pick = (items: readonly PaletteItem[]) => (filtering ? items.filter((item) => matchesQuery(item, words)) : [...items])
  const lists: Record<PaletteSectionId, PaletteItem[]> = {
    savings: pick(input.savings),
    funds: pick(input.funds),
    stocks: pick(input.stocks),
    pages: [...pick(input.pages), ...(filtering ? pick(input.categories) : [])],
    actions: pick(input.actions),
  }
  const empty = filtering && Object.values(lists).every((items) => items.length === 0)
  if (empty) {
    lists.pages = [...input.pages]
    lists.actions = [...input.actions]
  }
  const sections = (Object.keys(SECTION_LABEL) as PaletteSectionId[]).flatMap((id) => {
    const all = lists[id]
    if (all.length === 0) return []
    const items = id === "funds" && !input.fundsExpanded && all.length > FUNDS_PREVIEW ? all.slice(0, FUNDS_PREVIEW) : all
    return [{ id, label: SECTION_LABEL[id], items, total: all.length, hidden: all.length - items.length, counted: PRODUCT_SECTIONS.includes(id) || (filtering && !empty) }]
  })
  return { sections, empty }
}

/** A text split where the query's words occur in it, for bolding them. */
export function highlightParts(text: string, query: string): { text: string; match: boolean }[] {
  const words = queryWords(query)
  if (words.length === 0 || text === "") return [{ text, match: false }]
  const pattern = new RegExp(`(${words.map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length).join("|")})`, "gi")
  return text.split(pattern).filter((part) => part !== "").map((part) => ({ text: part, match: words.includes(part.toLocaleLowerCase()) }))
}

/** Whether a key press should open the palette: the shortcut alone, and never while typing in a field or a dialog. */
export function opensPalette(event: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey">, target: Element | null): boolean {
  if (event.key !== SEARCH_SHORTCUT_KEY || event.ctrlKey || event.metaKey || event.altKey) return false
  return !target?.closest("input, textarea, select, [contenteditable=true], [contenteditable=''], [role=dialog]")
}
