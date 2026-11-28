import { useQuery } from "@tanstack/react-query"
import { Link } from "react-router-dom"
import { useGiwaAdmin } from "./admin-context"
import { giwaApi } from "./api"
import {
  automationSummary,
  goldAutomationRow,
  keeperAutomationRow,
  lowGasHint,
  priceBotAutomationRow,
  type AutomationRead,
  type AutomationRow,
} from "./automation-status"
import { readableError } from "./contracts"
import { Pill } from "./stocks-admin/ui"

// The Automation card at the top of the Monitoring page: the jobs that run by themselves, at a glance, each linking to
// the page with its details. It reads what those pages read, under the same query keys (one cache): the keeper's
// heartbeat (ArcoUSD), the ArcoGOLD savings read (Gold) and the price bot's status (Prices). No endpoint of its own.

const REFRESH = 60_000

export function AutomationSection() {
  const { auth } = useGiwaAdmin()
  const keeperQuery = useQuery({
    queryKey: ["giwa", "arcousd-admin", "keeper"],
    queryFn: () => giwaApi.admin.arcousdKeeper(auth),
    enabled: auth.ready,
    refetchInterval: REFRESH,
  })
  const goldQuery = useQuery({
    queryKey: ["giwa", "admin-gold", "savings"],
    queryFn: () => giwaApi.arcogold.savings(),
    refetchInterval: REFRESH,
  })
  const priceBotQuery = useQuery({
    queryKey: ["giwa", "admin", "price-bot"],
    queryFn: () => giwaApi.admin.priceBot(auth),
    enabled: auth.ready,
    refetchInterval: REFRESH,
  })
  const read = <T,>(query: { data: T | undefined; isError: boolean; error: unknown }): AutomationRead<T> => ({
    data: query.data ?? null,
    error: query.isError ? readableError(query.error) : null,
  })
  const now = Date.now()
  const keeper = read(keeperQuery)
  const rows = [keeperAutomationRow(keeper, now), goldAutomationRow(keeper, read(goldQuery), now), priceBotAutomationRow(read(priceBotQuery), now)]
  return <AutomationCard rows={rows} />
}

/** Pure view: the summary line and one row per job. Rows stack at phone width; nothing scrolls sideways. */
export function AutomationCard({ rows }: { rows: readonly AutomationRow[] }) {
  const summary = automationSummary(rows)
  return (
    <section
      className="w-full min-w-0 rounded-[var(--radius-card)] bg-[var(--color-arco-surface)] p-5 shadow-[var(--shadow-control)]"
      data-testid="automation-card"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-[var(--color-arco-ink)]">Automation</h2>
        <span
          className={`text-xs font-medium ${summary.tone === "negative" ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-muted)]"}`}
          data-testid="automation-summary"
        >
          {summary.text}
        </span>
      </div>
      <div className="mt-3 hidden gap-x-4 text-[11px] text-[var(--color-arco-muted)] md:grid md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1fr)_auto]" aria-hidden="true">
        <span>Job</span>
        <span>Last run</span>
        <span>Next</span>
        <span>Wallet gas</span>
        <span>Details</span>
      </div>
      <ul className="mt-1 divide-y divide-[var(--color-arco-border)]">
        {rows.map((row) => (
          <li key={row.id} className="grid min-w-0 gap-x-4 gap-y-1 py-3 text-sm md:grid-cols-[minmax(0,1.4fr)_minmax(0,0.8fr)_minmax(0,1.6fr)_minmax(0,1fr)_auto] md:items-start" data-testid={`automation-${row.id}`}>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium text-[var(--color-arco-ink)]">{row.name}</span>
                <Pill tone={row.status.tone}>{row.status.label}</Pill>
              </div>
              {row.detail && (
                <p className={`mt-0.5 break-words text-[11px] ${row.attention ? "text-[var(--color-arco-down)]" : "text-[var(--color-arco-muted)]"}`}>{row.detail}</p>
              )}
            </div>
            <Cell label="Last run" value={row.lastRun} />
            <Cell label="Next" value={row.next ?? "—"} />
            <div className="min-w-0">
              <span className="text-[11px] text-[var(--color-arco-muted)] md:hidden">Wallet gas </span>
              <span className={`tabular-nums ${row.gas?.low ? "font-medium text-[var(--color-arco-down)]" : "text-[var(--color-arco-ink)]"}`}>{row.gas?.text ?? "—"}</span>
              {row.gas?.low && <p className="text-[11px] text-[var(--color-arco-down)]">{lowGasHint(row)}</p>}
            </div>
            <Link
              to={`../${row.page}`}
              relative="path"
              className="text-xs font-medium text-[var(--color-arco-ink)] underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-arco-ink)]"
            >
              {row.linkLabel} →
            </Link>
          </li>
        ))}
      </ul>
    </section>
  )
}

function Cell({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 break-words">
      <span className="text-[11px] text-[var(--color-arco-muted)] md:hidden">{label} </span>
      <span className="text-[var(--color-arco-ink)]">{value}</span>
    </div>
  )
}
