// Bounded ERC-20 balance reads for the admin Monitoring page.
//
// Before this module, the Monitoring reader fired one `balanceOf` request per depositor,
// all at once, for every product in parallel (~2,130 simultaneous HTTP requests on one
// /vaults load in production). Each in-flight request holds its own socket, request and
// response buffers, so memory grew with the depositor count until the 512 MB API service
// was OOM-killed. The limiter below caps how many reads are outstanding at any moment.

// At most this many `balanceOf` calls are in flight across the whole process for the
// monitoring reader. Shared by every product and every request (11 products loading at
// once still total ≤ 25), so memory stays flat no matter how many depositors exist; the
// cost is wall time (≈ reads / 25 × RPC latency), which the depositor cache amortises.
export const MONITORING_BALANCE_READ_CONCURRENCY = 25

export type ConcurrencyLimiter = <T>(task: () => Promise<T>) => Promise<T>

// FIFO limiter: at most `max` tasks run at once; the rest wait in a queue of closures
// (a few hundred bytes each, versus an open HTTP request each).
export function createConcurrencyLimiter(max: number): ConcurrencyLimiter {
  if (!Number.isInteger(max) || max < 1) throw new Error(`concurrency limit must be a positive integer, got ${max}`)
  let active = 0
  const queue: (() => void)[] = []
  const release = () => {
    active -= 1
    const next = queue.shift()
    if (next) next()
  }
  return <T>(task: () => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1
        let running: Promise<T>
        try {
          running = task()
        } catch (error) {
          running = Promise.reject(error)
        }
        running.then(resolve, reject).finally(release)
      }
      if (active < max) start()
      else queue.push(start)
    })
}

// Same contract as before: `Record<address, balanceString>` for every address, or `null`
// when any read fails. After the first failure the reads of this call that have not
// started yet are skipped (the result is null anyway), so a dead RPC does not keep the
// queue busy.
export function createTokenBalanceReader(deps: {
  readBalance: (tokenAddress: string, address: string) => Promise<bigint | string>
  limit: ConcurrencyLimiter
}): (tokenAddress: string, addresses: string[]) => Promise<Record<string, string> | null> {
  return async (tokenAddress, addresses) => {
    let failed = false
    const balances = await Promise.all(
      addresses.map((address) =>
        deps.limit(async () => {
          if (failed) return null
          try {
            const balance = await deps.readBalance(tokenAddress, address)
            return [address, balance.toString()] as const
          } catch {
            failed = true
            return null
          }
        }),
      ),
    )
    if (failed) return null
    // Input order kept, as the old Promise.all + Object.fromEntries did.
    return Object.fromEntries(balances.filter((entry) => entry != null))
  }
}
