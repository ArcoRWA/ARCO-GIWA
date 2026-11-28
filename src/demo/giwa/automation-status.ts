import { agoText, durationText, gasText, keeperBadge, keeperDistributeText } from "./arcousd-admin"
import { goldNextDistribution, goldTimeText } from "./gold-admin"
import { priceBotGas, priceBotHeadline } from "./price-bot-status"
import type { Tone } from "./stocks-admin/ui"
import type { GiwaArcoGoldSavings, GiwaArcoUSDKeeper, GiwaPriceBotStatus } from "./types"

// Pure model of the Automation card at the top of the Monitoring page: one row per job that runs by itself (the ArcoUSD
// keeper's queue and Savings yield, its ArcoGOLD yield step, and the fund price bot), from the same reads as the pages
// that show them in detail (ArcoUSD, Gold, Prices). Wording follows those pages: keeperBadge and priceBotHeadline.

export type AutomationStatusLabel = "Running" | "Dry run" | "Off" | "Not reporting" | "Error" | "Unavailable" | "Loading"
/** The console page with the details, as its tab id (console /vaults/<id>, legacy app /admin/<id>). */
export type AutomationPage = "arcousd" | "gold" | "prices"

export type AutomationRow = {
  readonly id: "keeper" | "gold" | "price-bot"
  readonly name: string
  readonly status: { readonly label: AutomationStatusLabel; readonly tone: Tone }
  /** One short line on why, when the status alone does not say it; null otherwise. */
  readonly detail: string | null
  /** "9m ago" / "—". */
  readonly lastRun: string
  /** The next thing it will do, with a local time where known; null when nothing is expected (off). */
  readonly next: string | null
  /** The job's wallet gas; null when it has no running wallet to show. */
  readonly gas: { readonly text: string; readonly low: boolean } | null
  readonly attention: boolean
  readonly page: AutomationPage
  readonly linkLabel: string
}

/** A read as the card gets it: the data (or null while loading), and the error text of a failed read. */
export type AutomationRead<T> = { readonly data: T | null; readonly error: string | null; readonly loading?: boolean }

const UNAVAILABLE = { label: "Unavailable", tone: "attention" } as const
const LOADING = { label: "Loading", tone: "neutral" } as const
const OFF = { label: "Off", tone: "neutral" } as const
const ERROR = { label: "Error", tone: "negative" } as const
const NOT_REPORTING = { label: "Not reporting", tone: "negative" } as const

const needsAttention = (status: AutomationRow["status"], gas: AutomationRow["gas"]) =>
  status.label === "Not reporting" || status.label === "Error" || status.label === "Unavailable" || Boolean(gas?.low)

/** "Running" / "Dry run" for a running mode, with the tones the pages use. */
function modeStatus(mode: string | undefined): AutomationRow["status"] {
  return mode === "live" ? { label: "Running", tone: "positive" } : { label: "Dry run", tone: "attention" }
}

/** The keeper's status as the Keeper bot card judges it (keeperBadge): failing after 10 minutes without a good round. */
function keeperStatus(read: AutomationRead<GiwaArcoUSDKeeper>, now: number): { status: AutomationRow["status"]; detail: string | null } | null {
  if (read.error && !read.data) return { status: UNAVAILABLE, detail: read.error }
  if (!read.data) return { status: LOADING, detail: null }
  if (read.data.status === "unavailable") return { status: UNAVAILABLE, detail: read.data.error ?? "The keeper status could not be read" }
  if (read.data.status === "not-deployed") return { status: OFF, detail: "ArcoUSD is not deployed" }
  const keeper = read.data.keeper
  const mode = keeper?.report?.mode
  if (!keeper || !mode || mode === "off") return { status: OFF, detail: keeper ? null : "The keeper has not run yet" }
  const badge = keeperBadge(keeper, now)
  if (badge.label === "Not running") return { status: NOT_REPORTING, detail: "The keeper has stopped reporting. Check the arco-arcousd-keeper worker." }
  if (badge.label.endsWith("failing")) return { status: ERROR, detail: keeper.lastError }
  if (badge.label.endsWith("retrying")) return { status: modeStatus(mode), detail: "The last round failed; it is retrying" }
  return null // running normally: the caller says what it does
}

function keeperGas(read: AutomationRead<GiwaArcoUSDKeeper>): AutomationRow["gas"] {
  const report = read.data?.keeper?.report
  if (!report || report.mode !== "live") return null
  return { text: gasText(report.gasBalanceWei), low: Boolean(report.lowGas) || report.canAffordTx === false }
}

/** ArcoUSD queue & yield: the keeper pays the redemption queue each round and sends Savings yield when it is due. */
export function keeperAutomationRow(read: AutomationRead<GiwaArcoUSDKeeper>, now: number): AutomationRow {
  const keeper = read.data?.keeper ?? null
  const report = keeper?.report ?? null
  const judged = keeperStatus(read, now)
  const status = judged?.status ?? modeStatus(report?.mode)
  const gas = keeperGas(read)
  const running = status.label === "Running" || status.label === "Dry run" || status.label === "Not reporting" || status.label === "Error"
  let next: string | null = null
  if (running && report) {
    const distribute = report.distribute
    const nextAt = distribute?.nextAt ? Date.parse(distribute.nextAt) : Number.NaN
    const savings =
      distribute?.state === "waiting" && Number.isFinite(nextAt) && nextAt > now
        ? `Savings yield after ${goldTimeText(distribute.nextAt)}`
        : distribute
          ? `Savings: ${keeperDistributeText(distribute, now)}`
          : null
    const queue = `Pays the queue every ${durationText(report.intervalMs / 1000)}`
    next = savings ? `${queue} · ${savings}` : queue
  }
  return {
    id: "keeper",
    name: "ArcoUSD queue & yield",
    status,
    detail: judged?.detail ?? null,
    lastRun: keeper ? agoText(keeper.lastRunAt, now) : "—",
    next,
    gas,
    attention: needsAttention(status, gas),
    page: "arcousd",
    linkLabel: "ArcoUSD",
  }
}

/**
 * Gold yield: the keeper's ArcoGOLD step (it calls the gold distributor's distribute() when due), and when the gold
 * distributor may next run, from the ArcoGOLD read the Gold page uses.
 */
export function goldAutomationRow(keeperRead: AutomationRead<GiwaArcoUSDKeeper>, goldRead: AutomationRead<GiwaArcoGoldSavings>, now: number): AutomationRow {
  const keeper = keeperRead.data?.keeper ?? null
  const report = keeper?.report ?? null
  const base = { id: "gold" as const, name: "Gold yield", page: "gold" as const, linkLabel: "Gold", lastRun: keeper ? agoText(keeper.lastRunAt, now) : "—" }

  const goldNotDeployed = goldRead.data?.status === "not-deployed" || (goldRead.data?.status === "live" && goldRead.data.contracts?.distributor === null)
  // When the gold distributor may next run: the Gold page's own line, in local time.
  let schedule: { text: string; attention: boolean } | null = null
  if (goldRead.error && !goldRead.data) schedule = { text: "The gold distributor could not be read", attention: true }
  else if (goldRead.data?.yield) {
    const line = goldNextDistribution(goldRead.data.yield, now)
    schedule = { text: line.label, attention: line.attention }
  } else if (goldRead.data && goldRead.data.status !== "live") schedule = { text: "The gold distributor could not be read", attention: true }

  const judged = keeperStatus(keeperRead, now)
  if (judged && judged.status.label !== "Running" && judged.status.label !== "Dry run") {
    // The keeper itself is off, silent, failing or unread: so is its gold step.
    const status = judged.status.label === "Off" && goldNotDeployed ? OFF : judged.status
    const detail = judged.status.label === "Off" ? (goldNotDeployed ? "ArcoGOLD has no distributor" : "The keeper is off: distribute from the Gold page") : judged.detail
    const gas = keeperGas(keeperRead)
    return { ...base, status, detail, next: judged.status.label === "Off" ? null : (schedule?.text ?? null), gas, attention: needsAttention(status, gas) }
  }

  const step = report?.goldDistribute
  const gas = keeperGas(keeperRead)
  let status: AutomationRow["status"] = judged?.status ?? modeStatus(report?.mode)
  let detail: string | null = judged?.detail ?? null
  if (step === undefined) {
    detail = "This keeper does not report a gold step yet"
  } else if (step?.state === "off" || step?.state === "not-deployed") {
    status = OFF
    detail = keeperDistributeText(step, now, "gold")
  } else if (step?.state === "error" || step?.state === "reverts") {
    status = ERROR
    detail = keeperDistributeText(step, now, "gold")
  } else if (step) {
    detail = step.state === "waiting" ? null : keeperDistributeText(step, now, "gold")
  }
  const next = status.label === "Off" ? null : (schedule?.text ?? null)
  // The Gold page's attention cases count too: distributor paused, due with nothing to pay, or unreadable.
  return { ...base, status, detail, next, gas, attention: needsAttention(status, gas) || Boolean(status.label !== "Off" && schedule?.attention) }
}

const PRICE_LABEL: Record<string, AutomationStatusLabel> = {
  Running: "Running",
  "Dry run": "Dry run",
  Off: "Off",
  "Not reporting": "Not reporting",
  "Running with errors": "Error",
  "Dry run with errors": "Error",
  Unavailable: "Unavailable",
  Loading: "Loading",
}

/** The start of the next UTC day after `now`, as ISO: the price bot posts once a UTC day. */
function nextUtcDay(now: number): string {
  const day = Math.floor(now / 86_400_000) + 1
  return new Date(day * 86_400_000).toISOString()
}

/** Price bot: posts the daily HOME, PPLUS, JX, aBTC and aXRP prices (priceBotHeadline's wording). */
export function priceBotAutomationRow(read: AutomationRead<GiwaPriceBotStatus>, now: number): AutomationRow {
  const base = { id: "price-bot" as const, name: "Price bot", page: "prices" as const, linkLabel: "Prices" }
  if (read.error && !read.data) {
    return { ...base, status: UNAVAILABLE, detail: read.error, lastRun: "—", next: null, gas: null, attention: true }
  }
  const headline = priceBotHeadline(read.data)
  const label = PRICE_LABEL[headline.label] ?? "Error"
  const status: AutomationRow["status"] =
    label === "Error" ? ERROR : label === "Not reporting" ? NOT_REPORTING : label === "Unavailable" ? UNAVAILABLE : label === "Off" ? OFF : label === "Loading" ? LOADING : modeStatus(read.data?.bot?.report?.mode)
  const bot = read.data?.bot ?? null
  const report = bot?.report ?? null
  const running = report?.mode === "live" || report?.mode === "dry-run"
  const gas = running && report?.mode === "live" ? priceBotGas(report) : null
  let next: string | null = null
  if (running) {
    const today = Math.floor(now / 86_400_000)
    const funds = report?.funds ?? []
    const doneToday = funds.length > 0 && funds.every((fund) => fund.postedAt && Math.floor(Date.parse(fund.postedAt) / 86_400_000) === today)
    const interval = typeof report?.intervalMs === "number" && report.intervalMs > 0 ? report.intervalMs : 600_000
    next = doneToday ? `Next prices after ${goldTimeText(nextUtcDay(now))}` : `Posts today's prices within ${durationText(interval / 1000)}`
  }
  const detail = label === "Running" || label === "Dry run" || label === "Loading" ? null : headline.detail || null
  return { ...base, status, detail, lastRun: bot ? agoText(bot.lastRunAt, now) : "—", next, gas, attention: needsAttention(status, gas) }
}

/** Under a low gas balance: which wallet to fund. */
export function lowGasHint(row: Pick<AutomationRow, "id">): string {
  return `Low: send GIWA Sepolia ETH to the ${row.id === "price-bot" ? "bot" : "keeper"} wallet`
}

/** The line above the rows: "All running", "2 need attention", or "Nothing needs attention · 1 off". */
export function automationSummary(rows: readonly AutomationRow[]): { text: string; tone: Tone } {
  const attention = rows.filter((row) => row.attention).length
  if (attention > 0) return { text: `${attention} need${attention === 1 ? "s" : ""} attention`, tone: "negative" }
  if (rows.some((row) => row.status.label === "Loading")) return { text: "Loading", tone: "neutral" }
  const off = rows.filter((row) => row.status.label === "Off").length
  if (off === 0) return { text: "All running", tone: "positive" }
  return { text: `Nothing needs attention · ${off} off`, tone: "neutral" }
}
