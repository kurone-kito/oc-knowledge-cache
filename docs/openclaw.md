# Running the two OpenClaw instances

The system uses two OpenClaw gateways, generated from this repository as two
isolated profiles (see [architecture](architecture.md) for why). This page
shows how to generate and start them and what they can and cannot do. The
`knowledge` instance is the private hub; where a new capability belongs is
decided in [architecture](architecture.md#where-a-new-capability-goes).

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
    workspace/AGENTS.md      operating instructions of the web agent
    workspace/skills/web-research/SKILL.md
  knowledge/
    openclaw.json            config for the knowledge instance
    workspace/AGENTS.md      operating instructions of the knowledge agent
    workspace/skills/knowledge-search/SKILL.md
```

The `AGENTS.md` of each workspace is written from
`openclaw/workspace/<profile>/instructions.md`. For the knowledge agent it says
that the design documents are reachable only through the search skill, which
to read first, and not to answer from general knowledge when the cache has
nothing. OpenClaw would otherwise seed a generic assistant template (search
the web, check calendars, commit and push) that fits neither instance, and a
local model then often does not use its skill: with six plain questions the
agent searched the cache once under that template and six times under the
generated instructions. Like the skills, the file is generated: edits are
replaced when the profiles are generated again, and the previous copy is kept
as `AGENTS.md.bak`. Put rules of your own in the `AGENTS.md` of the project
repository, which the knowledge agent reads as project context.

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

## Talk to them

An `openclaw` command talks to the instance whose two variables
(`OPENCLAW_CONFIG_PATH` and `OPENCLAW_STATE_DIR`) are set in that terminal; the
port and the token come from that profile's config. So `openclaw tui` opens
the terminal UI of the instance you started the same way, `openclaw agent
--agent <agent> --message "..."` asks it one question (`knowledge` or
`research`, the one agent of that profile), and `openclaw
dashboard` opens its Control UI. Without the variables, a command reaches the
default `~/.openclaw` profile instead, never one of these two. The explicit
form, `openclaw tui --url ws://127.0.0.1:<port> --token <token>` (the port of
that profile: 19300 for knowledge and 19100 for web unless you chose others),
ignores the config and needs the `gateway.auth.token` of the profile on the
command line, where shell history and process lists show it. The gateways
listen on the loopback interface only: from another machine, forward the
port first, for example with `ssh -L 19300:127.0.0.1:19300 <host>`.

If a model still ignores the search skill, start the message with
`$knowledge-search` to make the agent read it first. The
[README tutorial](../README.md#tutorial) walks through both instances.

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

- **`AGENTS.md` is guidance, not enforcement.** It makes a model use its skill
  and stay on topic; it does not stop a model that ignores it, and a page or a
  document can still try to talk a model out of it. The tool policy and the
  limits below are what hold.
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

## Provisioning a machine

```sh
pnpm run provision plan     # list what is missing; changes nothing
pnpm run provision apply    # do the automatic steps
```

The plan compares the machine with what the system needs: a running Ollama,
the recommended agent and embedding models, the OpenClaw CLI, and generated
profiles. Choose models yourself with `--agent-model` and `--embed-model`; an
existing cache keeps its embedding model. `apply` pulls the missing models and
generates the profiles. Starting Ollama and installing OpenClaw are printed as
MANUAL steps and never done for you.

The profiles count as up to date only when both configs, both skills and both
`AGENTS.md` files exist (the files equal to the repository's),
the isolation properties still hold (including each agent's own workspace and
the project directory), the knowledge skill points at this run's `--data` and
this repository, and they name the chosen agent model, the `--ollama-url` and
the `--project-repo` of this run. Pass the same `--out`,
`--data`, `--project-repo` and `--ollama-url` every time: profiles that differ
are generated again (leaving `--project-repo` out means "no project
repository"), while settings you added by hand are not judged. The gateway
ports are yours to choose: a valid port you set by hand is kept when the
profiles are generated again, and only a missing or unusable one (not a
number, below 1024, or too close to the other gateway) is repaired.

Something in the way of a generated file (a link, or a file or folder of the
wrong kind) is listed as a MANUAL step: a person removes it, and nothing is
written over it. If the model list cannot be read, the plan says what Ollama
answered instead of only asking you to start it. Profiles are only generated
while Ollama is reachable and, if their agent
model has to be pulled first, only after that pull succeeded. A failed
embedding pull does not hold them back. A model download that goes silent for
two minutes (`--pull-idle-timeout`) fails instead of hanging.

Generating the profiles again replaces their config files; the previous config
(with anything you added by hand) is kept as `openclaw.json.bak` next to it,
and likewise `AGENTS.md.bak` for the instructions.
For an Ollama on another machine, pass `--ram-gib`, `--vram-gib` and
`--unified-memory` so that the models are chosen for that machine, not for this
one.

Both commands are safe to repeat: on a machine that is already set up, `plan`
prints no automatic step and `apply` does nothing. The exit status is 0 when
the machine is provisioned and 2 when it is not: `plan --check` and `apply`
both exit 2 while a step is pending (including a MANUAL one), a step failed, or
no model fits the machine (printed as `UNMET`). That suits a scheduled check.

`mise.toml` pins pnpm and Ollama to exact versions and takes the latest
Node.js (this project needs Node.js 26 or later).

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
