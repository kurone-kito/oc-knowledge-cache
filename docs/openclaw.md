# Running the two OpenClaw instances

The system uses two OpenClaw gateways, generated from this repository as two
isolated profiles (see [architecture](architecture.md) for why). This page
shows how to generate and start them and what they can and cannot do.

## Generate the profiles

```sh
pnpm run openclaw:generate --project-repo <path to the project repository>
```

It picks the best installed agent model with `models:recommend` (override with
`--model`) and writes, under `.openclaw/` (git-ignored, outside the cache):

```text
.openclaw/
  web/
    openclaw.json            config for the web instance
    workspace/skills/web-research/SKILL.md
  knowledge/
    openclaw.json            config for the knowledge instance
    workspace/skills/knowledge-search/SKILL.md
```

Running it again rewrites the same files and keeps the gateway tokens, so
running gateways and clients stay valid. `--dry-run` prints the configs with
the tokens hidden.

## Start them

The command prints the exact lines for your shell. In two terminals:

```sh
OPENCLAW_CONFIG_PATH=<.openclaw/web/openclaw.json> \
OPENCLAW_STATE_DIR=<.openclaw/web/state> \
openclaw gateway --port 19100

OPENCLAW_CONFIG_PATH=<.openclaw/knowledge/openclaw.json> \
OPENCLAW_STATE_DIR=<.openclaw/knowledge/state> \
openclaw gateway --port 19300
```

Each instance has its own config, state directory, workspace and port; the
ports are 200 apart (OpenClaw needs at least 120 for derived browser ports)
and both gateways listen on loopback only, with token authentication.

Start the knowledge gateway from a shell in which `node -v` reports 26 or
later (for example through `mise exec --`). The skill runs
`pnpm run kc:search`, which uses the `node` on the gateway's `PATH`, and this
repository requires Node.js 26.

Feed the knowledge cache from the host, not from an agent:

```sh
pnpm run ingest --source <NAS share>
```

## What each instance can do

| Capability               | `web`               | `knowledge`                 |
| ------------------------ | ------------------- | --------------------------- |
| Web search and fetch     | yes                 | no (tool group denied)      |
| Read files               | its workspace only  | yes (project repository)    |
| Write files, run shell   | no                  | yes (coding profile)        |
| Skill                    | `web-research`      | `knowledge-search`          |
| Knowledge cache          | no                  | through `kc:search`         |
| `gateway`, `cron`        | denied              | denied                      |
| Spawn or message agents  | denied              | denied                      |

The `knowledge-search` skill tells the agent to call `pnpm run kc:search` with
the repository as the working directory and the question in an environment
variable (`--question-env`), so that quotes or `$(...)` in a question never
reach a shell. It also tells the agent to cite `path (Sheet!range)` for every
fact, and to say so when the cache has nothing relevant.

## Limits

- **Tool policy is not a network sandbox.** The knowledge instance has no web
  *tools*, but its shell tool can run any command, including `curl`. For a
  hard guarantee that nothing derived from the NAS leaves the machine, run
  that gateway in a VM or container whose only route is to Ollama. Moving the
  search into an MCP server on the host would also allow OpenClaw's sandbox
  with the network switched off (tracked in #15).
- **Tool policy is not a filesystem boundary either.** The knowledge instance
  has the coding tools, so it can change or delete whatever its OS user can,
  including the cache. Only the host-side `ingest` should write the data
  directory: make it read-only for the user that runs the gateways (or mount
  it read-only), and keep that user away from anything else that matters.
- **The relay between the instances does not exist yet** (#14). Until then the
  knowledge instance has no way to use the web instance, and a person has to
  carry web findings over.
- **Tried with OpenClaw 2026.9.9, once.** Both gateways start side by side on
  loopback, refuse the other instance's token, and `openclaw skills list`
  shows each only its own skill. A question put to the knowledge agent
  (`openclaw agent --agent knowledge`) was answered from the cache, with the
  file and the cell range, through the `exec` call that the skill describes
  (the question in `env`, never in the command). With a 35B local model on a
  small GPU that took about three minutes. What `config validate` cannot tell,
  and the gateway does: it needs `gateway.mode`, and the Ollama adapter must be
  told the context size (`params.num_ctx`), or its small default overflows
  with "prompt too large". Both are generated now. Report anything that
  behaves differently on your setup.
- **The security audit of OpenClaw rates the web instance critical, by
  design.** It runs a small local model with `web_fetch` and no sandbox. That
  instance has no shell, cannot write files, reads only its own workspace and
  never sees the NAS or the cache, so a poisoned page has nothing to take; if
  Docker is available, `agents.defaults.sandbox.mode: "all"` adds defense in
  depth. The warning about trusted proxies only matters if the Control UI is
  put behind a reverse proxy; both gateways listen on loopback only.
- Large models run slowly on small GPUs. `models:recommend` explains the fit
  of every installed model.

## Checking the configs

With OpenClaw installed:

```sh
pnpm run openclaw:generate --validate
```

or run the optional conformance test against a specific build by setting
`KC_OPENCLAW_CLI` to the `openclaw` executable (or its `openclaw.mjs`) before
`pnpm run test:unit`.

On Windows, a global npm install provides `openclaw.cmd`; the tools start it
through the shell, so the plain name `openclaw` works there too.
