import { spawn } from "node:child_process"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

export async function editPrompt(prompt: string, renderer: { suspend(): void; resume(): void }): Promise<string> {
  const editor = process.env.EDITOR?.trim()
  if (!editor) throw new Error("Set EDITOR before starting OpenCode, for example EDITOR='vi' or EDITOR='code --wait'.")

  const directory = await mkdtemp(join(tmpdir(), "shield-bash-prompt-"))
  const path = join(directory, "judge-prompt.md")
  try {
    await writeFile(path, prompt, { mode: 0o600 })
    renderer.suspend()
    try {
      // EDITOR is a user-supplied command and may include flags. Keep the file
      // path in an environment variable so it is never parsed as shell code.
      const fileArgument = process.platform === "win32" ? '"%SHIELD_BASH_PROMPT_FILE%"' : '"$SHIELD_BASH_PROMPT_FILE"'
      await new Promise<void>((resolve, reject) => {
        const child = spawn(`${editor} ${fileArgument}`, {
          shell: true,
          stdio: "inherit",
          env: { ...process.env, SHIELD_BASH_PROMPT_FILE: path },
        })
        child.once("error", reject)
        child.once("close", (code, signal) => {
          if (code === 0) resolve()
          else reject(new Error(`Editor exited ${signal ? `with signal ${signal}` : `with code ${code}`}. Prompt changes were not applied.`))
        })
      })
    } finally {
      renderer.resume()
    }
    const edited = await readFile(path, "utf8")
    if (!edited.trim()) throw new Error("Judge prompt cannot be empty. Use Restore default prompt instead.")
    return edited
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
