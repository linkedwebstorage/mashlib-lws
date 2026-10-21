// Every suite, one after another (they share no server or port):
//
//   node tests/run-all.mjs
//
// Needs: lwsd --no-auth at :8737 (with --browser for pod.mjs), lwsd with auth on at
// :8735, and the shell at :8738 — see each file's header.

import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = fileURLToPath(new URL('.', import.meta.url))
const SUITES = ['smoke.mjs', 'login.mjs', 'pod.mjs', 'didkey.mjs']
const summary = []

for (const suite of SUITES) {
  const started = Date.now()
  const result = spawnSync(process.execPath, [here + suite], { encoding: 'utf8', env: process.env })
  const lines = (result.stdout + result.stderr).split('\n')
  const passes = lines.filter(l => l.startsWith('PASS ')).length
  const fails = lines.filter(l => l.startsWith('FAIL '))

  summary.push({ suite, passes, fails: fails.length, seconds: Math.round((Date.now() - started) / 1000) })
  console.log(`== ${suite}: ${passes} passed, ${fails.length} failed, ${summary.at(-1).seconds}s`)
  for (const f of fails) console.log('   ' + f)
}

const failed = summary.reduce((n, s) => n + s.fails, 0)

console.log(failed ? `${failed} failed` : `all passed (${summary.reduce((n, s) => n + s.passes, 0)} checks)`)
process.exitCode = failed ? 1 : 0
