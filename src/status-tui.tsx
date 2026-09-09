import { createEffect, createSignal, For, onCleanup, Show } from "solid-js"
import type { Context } from "@opencode/plugin/tui/context"
import { StatusRpc, singleLine, statusLabel, type CheckRecord } from "./status"

export function setupStatusUI(ctx: Context): () => void {
  function useChecks(sessionID: () => string | undefined) {
    const [records, setRecords] = createSignal<CheckRecord[]>([])
    const [connected, setConnected] = createSignal(false)
    createEffect(() => {
      const id = sessionID()
      setRecords([])
      setConnected(false)
      if (!id) return
      const location = ctx.data.session.get(id)?.location ?? ctx.location ?? ctx.data.location.default()
      const rpc = ctx.client.rpc(StatusRpc)
      const controller = new AbortController()
      let revision = 0
      let loading = false
      const stop = rpc.events.on("changed", (event) => {
        const record = event.data as CheckRecord
        if (record.sessionID !== id || event.location.directory !== location.directory) return
        revision++
        setConnected(true)
        setRecords((previous) => {
          if (previous.some((item) => item.callID === record.callID && item.updatedAt >= record.updatedAt)) return previous
          return [...previous.filter((item) => item.callID !== record.callID), record].sort((a, b) => a.updatedAt - b.updatedAt).slice(-200)
        })
      })
      const refresh = async () => {
        if (loading) return
        loading = true
        const started = revision
        try {
          const result = await rpc.list({ sessionID: id }, {
            location,
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5_000)]),
          }) as CheckRecord[]
          if (controller.signal.aborted || revision !== started) return
          setRecords(result)
          setConnected(true)
        } catch {
          if (!controller.signal.aborted && revision === started) setConnected(false)
        } finally {
          loading = false
        }
      }
      void refresh()
      // Recover missed events after reconnects and server/plugin restarts.
      const timer = setInterval(() => void refresh(), 3_000)
      onCleanup(() => { controller.abort(); clearInterval(timer); stop() })
    })
    return { records, connected }
  }

  const stopFooter = ctx.ui.slot({
    append: "session.composer.top",
    render: (props) => {
      const checks = useChecks(() => props.sessionID)
      const checking = () => checks.records().filter((record) => record.state === "checking")
      const latest = () => checks.records().at(-1)
      const [visible, setVisible] = createSignal(false)
      createEffect(() => {
        if (checking().length) {
          setVisible(true)
          return
        }
        const record = latest()
        const remaining = record ? record.updatedAt + 5_000 - Date.now() : 0
        setVisible(remaining > 0)
        if (remaining <= 0) return
        // Use the verdict time so snapshot refreshes do not extend visibility.
        const timer = setTimeout(() => setVisible(false), remaining)
        onCleanup(() => clearTimeout(timer))
      })
      const label = () => {
        if (!checks.connected()) return "! Shield: status unavailable"
        const record = latest()
        if (!record) return "Shield: no checks recorded"
        if (record.state === "checking") return `◌ Shield: checking${checking().length > 1 ? ` (${checking().length} checks)` : ""}`
        return `${statusLabel(record)}${checking().length ? ` · ${checking().length} checking` : ""}`
      }
      return <Show when={visible()}><text fg={ctx.theme.text.default}>{label()}</text></Show>
    },
  })
  const stopPanel = ctx.ui.slot({
    append: "session.panel",
    render: (panel) => (
      <Show when={panel.name === "shield-bash.checks"}>
        {(_) => {
          const checks = useChecks(() => panel.sessionID)
          ctx.keymap.layer(() => ({
            commands: [
              { id: "shield-bash.close", bind: "escape", run: panel.close },
              { id: "shield-bash.fullscreen", bind: "f", run: panel.toggleFullscreen },
            ],
          }))
          return (
            <box flexDirection="column" height="100%" padding={1} gap={1}>
              <text fg={ctx.theme.text.default}>Shield checks · Esc: close · f: fullscreen</text>
              <text fg={ctx.theme.text.default}>Safety decisions, not command exit status. Latest 200 checks per location; cleared on server reload.</text>
              <Show when={!checks.connected()}><text>Status unavailable — reconnecting to Shield</text></Show>
              <Show when={checks.connected() && !checks.records().length}><text>No checks recorded for this session.</text></Show>
              <scrollbox flexGrow={1} focused={panel.focused}>
                <For each={[...checks.records()].reverse()}>{(record) => (
                  <box flexDirection="column" marginBottom={1}>
                    <text fg={ctx.theme.text.default}>{statusLabel(record)}</text>
                    <text>{singleLine(record.command, 500)}</text>
                    <Show when={record.detail}><text>{singleLine(record.detail, 2_000)}</text></Show>
                  </box>
                )}</For>
              </scrollbox>
            </box>
          )
        }}
      </Show>
    ),
  })
  return () => { stopFooter(); stopPanel() }
}
