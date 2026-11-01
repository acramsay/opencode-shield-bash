import { mkdir, writeFile } from "node:fs/promises"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

// Temporary workaround for anomalyco/opencode#39986: the packaged CLI does not
// run OpenTUI's Solid JSX transform on TSX under node_modules, so the published
// TUI must be precompiled. `@opentui/solid` does not export this subpath, so it
// is resolved from the package root rather than imported bare.
async function loadTransform() {
  const resolvePackageJson = async (): Promise<string> => {
    try {
      return fileURLToPath(import.meta.resolve("@opentui/solid/package.json"))
    } catch {
      try {
        return createRequire(import.meta.url).resolve("@opentui/solid/package.json")
      } catch {
        throw new Error(
          "build-tui: could not resolve @opentui/solid/package.json; is @opentui/solid installed?",
        )
      }
    }
  }
  const transformPath = join(dirname(await resolvePackageJson()), "scripts/solid-transform.js")
  const mod = (await import(pathToFileURL(transformPath).href)) as {
    transformSolidSource: (code: string, options: unknown) => Promise<string>
  }
  return mod.transformSolidSource
}

const sourcePath = fileURLToPath(new URL("../src/tui.tsx", import.meta.url))
const outputPath = fileURLToPath(new URL("../src/tui.compiled.tsx", import.meta.url))

const runtimeSpecifiers = new Set([
  "@opentui/core",
  "@opentui/core/testing",
  "@opentui/solid",
  "@opentui/solid/components",
  "@opentui/solid/jsx-runtime",
  "@opentui/solid/jsx-dev-runtime",
  "solid-js",
  "solid-js/store",
])
const runtimeModuleId = (s: string) => `opentui:runtime-module:${encodeURIComponent(s)}`

const transformSolidSource = await loadTransform()
const code = await Bun.file(sourcePath).text()
const compiled = await transformSolidSource(code, {
  filename: sourcePath,
  moduleName: runtimeModuleId("@opentui/solid"),
  resolvePath: (s: string) => (runtimeSpecifiers.has(s) ? runtimeModuleId(s) : null),
})

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(outputPath, `// @ts-nocheck\n${compiled}`)
console.log(`build-tui: wrote ${outputPath.replace(process.cwd() + "/", "")}`)
