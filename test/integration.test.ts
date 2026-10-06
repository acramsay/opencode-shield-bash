import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

// Drives the real plugin through a live opencode v2 process, against a local
// OpenAI-compatible stub that stands in for both the agent and the judge. This
// covers the wiring the unit tests fake: plugin loading, session.create with a
// parentID, the context-hook policy injection, and execute.before denial.
//
// Opt-in: skips when the opencode binary is absent. Override it with
// SHIELD_BASH_TEST_OPENCODE.

const BIN = process.env.SHIELD_BASH_TEST_OPENCODE ?? "opencode"
const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")

let currentVerdict: "allow" | "deny" = "allow"
let currentCommand = "echo SHIELD_ALLOW"

const encoder = new TextEncoder()
const sseChunk = (delta: unknown, finish: string | null) =>
  `data: ${JSON.stringify({
    id: "c",
    object: "chat.completion.chunk",
    created: 0,
    model: "m",
    choices: [{ index: 0, delta, finish_reason: finish }],
  })}\n\n`

const streamResponse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
        controller.close()
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  )

const textReply = (stream: boolean, text: string) => {
  if (stream) return streamResponse([sseChunk({ role: "assistant", content: "" }, null), sseChunk({ content: text }, null), sseChunk({}, "stop"), "data: [DONE]\n\n"])
  return Response.json({
    id: "c",
    object: "chat.completion",
    created: 0,
    model: "m",
    choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
  })
}

const toolCallReply = (stream: boolean, command: string) => {
  const args = JSON.stringify({ command })
  if (!stream) {
    return Response.json({
      id: "c",
      object: "chat.completion",
      created: 0,
      model: "m",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "shell", arguments: args } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
  }
  return streamResponse([
    sseChunk({ role: "assistant", tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "shell", arguments: "" } }] }, null),
    sseChunk({ tool_calls: [{ index: 0, function: { arguments: args } }] }, null),
    sseChunk({}, "tool_calls"),
    "data: [DONE]\n\n",
  ])
}

let server: ReturnType<typeof Bun.serve>

const writeProject = (project: string) => {
  mkdirSync(join(project, "plugins", "shield"), { recursive: true })
  writeFileSync(
    join(project, "plugins", "shield", "index.ts"),
    `export { default } from ${JSON.stringify(join(repoRoot, "src", "index.ts"))}\n`,
  )
  writeFileSync(
    join(project, "opencode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      model: "mock/m",
      providers: {
        mock: {
          name: "Mock",
          env: ["MOCK_API_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${server.port}/v1` },
          models: { m: { name: "Mock" } },
        },
      },
      plugins: [
        {
          package: "./plugins/shield",
          options: { providerID: "mock", modelID: "m", failure: "deny" },
        },
      ],
    }),
  )
}

const runAgent = async (project: string): Promise<string> => {
  const home = mkdtempSync(join(tmpdir(), "shield-bash-it-home-"))
  const proc = Bun.spawn([BIN, "run", "--standalone", "--auto", "-m", "mock/m", "go"], {
    cwd: project,
    env: {
      ...process.env,
      // opencode derives its location from PWD, not the process cwd, so a
      // spawned run would otherwise pick up the caller's project.
      PWD: project,
      MOCK_API_KEY: "test",
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_CACHE_HOME: join(home, "cache"),
      XDG_DATA_HOME: join(home, "data"),
      XDG_STATE_HOME: join(home, "state"),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("opencode run timed out")), 90_000))
  const finished = (async () => {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return { stdout, stderr, code }
  })()
  try {
    const { stdout, stderr } = await Promise.race([finished, timeout])
    return `${stdout}\n${stderr}`
  } finally {
    proc.kill()
    rmSync(home, { recursive: true, force: true })
  }
}

const available = Bun.which(BIN) !== null

describe.skipIf(!available)("shield-bash against a live opencode", () => {
  beforeAll(() => {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch(req) {
        const url = new URL(req.url)
        if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 })
        const body = await req.text()
        const parsed = body ? (JSON.parse(body) as { stream?: boolean; messages?: Array<{ role: string }> }) : {}
        const isJudge = body.includes("shield-bash policy") || body.includes("Return the JSON verdict")
        if (isJudge) {
          const verdict =
            currentVerdict === "allow"
              ? '{"decision":"allow"}'
              : '{"decision":"deny","category":"DG1","reason":"stub deny","alternative":null}'
          return textReply(Boolean(parsed.stream), verdict)
        }
        const hasToolResult = parsed.messages?.some((message) => message.role === "tool")
        if (hasToolResult) return textReply(Boolean(parsed.stream), "all done")
        return toolCallReply(Boolean(parsed.stream), currentCommand)
      },
    })
  })

  afterAll(() => server?.stop(true))

  test(
    "an allowed command runs",
    async () => {
      currentVerdict = "allow"
      currentCommand = "echo SHIELD_ALLOW"
      const project = mkdtempSync(join(tmpdir(), "shield-bash-it-"))
      writeProject(project)
      try {
        const output = await runAgent(project)
        expect(output).toContain("SHIELD_ALLOW")
      } finally {
        rmSync(project, { recursive: true, force: true })
      }
    },
    120_000,
  )

  test(
    "a denied command is blocked before it runs",
    async () => {
      currentVerdict = "deny"
      currentCommand = "echo SHIELD_DENY"
      const project = mkdtempSync(join(tmpdir(), "shield-bash-it-"))
      writeProject(project)
      try {
        const output = await runAgent(project)
        expect(output).toContain("shield-bash denied")
      } finally {
        rmSync(project, { recursive: true, force: true })
      }
    },
    120_000,
  )
})
