import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { emptyCounters, type Counters } from "./lib"
import { ShieldBash } from "./rpc"

// Fixed order keeps the line stable as error kinds come and go.
const ERROR_KIND_ORDER = ["timeout", "inference", "invalid-verdict"]

function formatCategories(byCategory: Record<string, number>): string {
  const categories = Object.keys(byCategory).sort()
  if (categories.length === 0) return "none"
  return categories.map((category) => `${category}×${byCategory[category]}`).join(" ")
}

function formatErrors(byKind: Record<string, number>): string {
  const kinds = Object.keys(byKind).sort((a, b) => {
    const ai = ERROR_KIND_ORDER.indexOf(a)
    const bi = ERROR_KIND_ORDER.indexOf(b)
    if (ai === -1 && bi === -1) return a.localeCompare(b)
    if (ai === -1) return 1
    if (bi === -1) return -1
    return ai - bi
  })
  if (kinds.length === 0) return "none"
  return kinds.map((kind) => `${byKind[kind]} ${kind}`).join("  ")
}

export function formatCounters(counters: Counters): string[] {
  const pending = counters.askPending > 0 ? `  ${counters.askPending} pending` : ""
  return [
    ` ${counters.allow} ✓   ${counters.deny} ✕   ${counters.ask} ?`,
    ` cached:  ${counters.allowCached}✓  ${counters.denyCached}✕`,
    ` denied:  ${formatCategories(counters.denyByCategory)}`,
    ` asked:   ${counters.askOnce} once  ${counters.askAlways} always  ${counters.askReject} reject${pending}`,
    ` errors:  ${formatErrors(counters.errorByKind)}`,
    ` wait:    ${(counters.waitMs / 1000).toFixed(1)}s`,
  ]
}

export default Plugin.define({
  id: "shield-bash-tui",
  setup(context) {
    const rpc = context.client.rpc(ShieldBash)

    const Sidebar = (props: { sessionID: string }) => {
      const [counters, setCounters] = createSignal<Counters | null>(null)
      const [failed, setFailed] = createSignal(false)

      // The sidebar can outlive its session during teardown, so a missing root
      // reads as no data instead of throwing.
      const rootID = (): string | null => {
        try {
          return context.data.session.root(props.sessionID)
        } catch {
          return null
        }
      }

      // The RPC route resolves to the server's default location unless the call
      // names one, so a project-local install would otherwise miss its own
      // registration. Prefer the session's location; fall back to the TUI's.
      const location = () =>
        context.data.session.get(props.sessionID)?.location ?? context.location

      const refresh = async () => {
        const root = rootID()
        if (root === null) return
        try {
          setCounters(await rpc.stats({ rootID: root }, { location: location() }))
          setFailed(false)
        } catch {
          setFailed(true)
        }
      }

      createEffect(() => {
        void refresh()
      })

      const unsubscribe = rpc.events.on("verdict", (event) => {
        if (event.data.rootID !== rootID()) return
        setCounters(event.data.counters)
        setFailed(false)
      })
      onCleanup(unsubscribe)

      const lines = () => formatCounters(counters() ?? emptyCounters())

      return (
        <box flexDirection="column" width="100%">
          <text>🛡 shield-bash</text>
          {failed() ? (
            <text>  stats unavailable</text>
          ) : (
            lines().map((line) => <text>{line}</text>)
          )}
        </box>
      )
    }

    context.ui.slot({
      append: "sidebar.content",
      render: ({ sessionID }) => <Sidebar sessionID={sessionID} />,
    })
  },
})
