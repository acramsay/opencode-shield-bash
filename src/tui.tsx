import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createEffect, createSignal, onCleanup } from "solid-js"
import { emptyCounters, type Counters } from "./lib"
import { ShieldBash } from "./rpc"

export type SummaryRole = "allow" | "deny" | "ask" | "error" | "muted"
export type SummarySegment = { text: string; role: SummaryRole }

export function formatSummary(counters: Counters): SummarySegment[] {
  return [
    { text: `${counters.allow} ✓`, role: "allow" },
    { text: `   ${counters.deny} 🛡`, role: "deny" },
  ]
}

export type CounterLine = { label: string; segments: SummarySegment[] }

export function formatCounters(counters: Counters): CounterLine[] {
  const errors = Object.values(counters.errorByKind).reduce((sum, n) => sum + n, 0)
  return [
    {
      label: "Cached",
      segments: [
        { text: `${counters.allowCached} ✓`, role: "allow" },
        { text: `   ${counters.denyCached} 🛡`, role: "deny" },
      ],
    },
    {
      label: "Questions & Errors",
      segments: [
        { text: `${counters.ask} ?`, role: "ask" },
        { text: `   ${errors} x`, role: errors > 0 ? "error" : "muted" },
      ],
    },
    { label: "Wait Time", segments: [{ text: `${(counters.waitMs / 1000).toFixed(1)}s`, role: "muted" }] },
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
      const summary = () => formatSummary(counters() ?? emptyCounters())

      const summaryColor = (role: SummaryRole): RGBA => {
        switch (role) {
          case "allow":
            return context.theme.text.feedback.success.base
          case "error":
            return context.theme.text.feedback.error.base
          default:
            return context.theme.text.muted
        }
      }

      // @opentui/solid reads span colors from style.fg (a bare fg prop is ignored),
      // and its SpanProps type omits the field.
      const metrics = (segments: SummarySegment[]) => (
        <text>
          {segments.map((segment) => (
            <span {...{ style: { fg: summaryColor(segment.role) } }}>{segment.text}</span>
          ))}
        </text>
      )

      return (
        <box flexDirection="column" width="100%">
          <box flexDirection="row" justifyContent="space-between" width="100%">
            <text style={{ fg: context.theme.text.base }}>Shield Bash</text>
            {failed() ? null : metrics(summary())}
          </box>
          {failed() ? (
            <text style={{ fg: context.theme.text.muted }}>  stats unavailable</text>
          ) : (
            lines().map((line) => (
              <box flexDirection="row" justifyContent="space-between" width="100%" paddingLeft={1}>
                <text style={{ fg: context.theme.text.muted }}>{line.label}</text>
                {metrics(line.segments)}
              </box>
            ))
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
