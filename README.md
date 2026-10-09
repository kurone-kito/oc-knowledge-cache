# 📚 oc-knowledge-cache

Experiment on non-volatile caching of knowledge using OpenClaw

The design documents of a project often live as Excel files on a NAS, and
their content must not be sent to a cloud LLM. This repository turns them
into a searchable cache **on your own machine** and lets a local LLM
([Ollama](https://ollama.com)) answer from it through
[OpenClaw](https://docs.openclaw.ai).

```text
NAS (Excel) --ingest--> local cache --kc:search--> knowledge instance --> you
                        (SQLite)                   (OpenClaw + Ollama)

Internet <--------------------------------------- web instance -------> you
                                                   (OpenClaw + Ollama)
```

Two OpenClaw instances are generated from this repository. They are kept
apart on purpose:

| Instance    | Agent       | Port    | Can do                                    |
| ----------- | ----------- | ------- | ----------------------------------------- |
| `knowledge` | `knowledge` | `19300` | search the cache, work on a project repo  |
| `web`       | `research`  | `19100` | search and read the Web, nothing else     |

The knowledge instance has no web tools and the web instance never sees the
NAS or the cache. [docs/architecture.md](docs/architecture.md) explains why
and [docs/openclaw.md](docs/openclaw.md) lists what the isolation does _not_
cover.

## System Requirements

- Node.js: Latest (`>=26.0.0`)
- mise-en-place
- [Ollama](https://ollama.com), running (a GPU helps; `models:recommend`
  tells what fits your machine)
- The [OpenClaw](https://docs.openclaw.ai) CLI, for example
  `npm install -g openclaw` (tried with 2026.9.9)

## Tutorial

This walks from a fresh clone to asking questions of both instances; most of
the time goes into model downloads. All `pnpm run` commands are run in the
root of this repository, and `--help` on any of them lists its options.

### 1. Install

```sh
mise install
pnpm install
```

### 2. Provision the machine

```sh
pnpm run models:recommend       # which installed models fit this machine
pnpm run provision plan --project-repo <the repository you code on>
```

`--project-repo` is the repository the knowledge agent works in: your own
project, **not this checkout**. The profiles go to `.openclaw/` in this
checkout by default (`--out` changes that), and a profile folder may not lie
inside the project repository, so `--project-repo .` fails with "the profiles
are not isolated" unless `--out` points elsewhere.

The plan lists what this machine needs: a running Ollama, the recommended
agent and embedding models, the OpenClaw CLI and the generated profiles.
Starting Ollama and installing OpenClaw are printed as `MANUAL` steps;
everything else is done by:

```sh
pnpm run provision apply --project-repo <the repository you code on>
```

It pulls the missing models and writes the two profiles. Pass the same
`--out`, `--data`, `--project-repo` and, if you use them, `--ollama-url`,
`--agent-model`, `--embed-model` and the hardware overrides (`--ram-gib`,
`--vram-gib`, `--unified-memory`) to `plan` and `apply` every time, so that
the profiles are recognized as up to date. Running `plan` or `apply` again on
a machine that is ready does nothing.

### 3. Fill the cache

Point `ingest` at the folder that holds the Excel files, for example a
mounted NAS share. The share is only read:

```sh
pnpm run ingest --source <share> --dry-run   # what would happen
pnpm run ingest --source <share>             # do it
```

```text
Embedding model: nomic-embed-text-v2-moe:latest (recommended, context 512)
[1/2] added   ok            design/basic-design.xlsx  (1 chunks)
[2/2] added   ok            design/notes.md  (1 chunks)
2 done, 0 skipped, 0 failed, 0 not attempted; 0 unchanged.
store: 2 documents, 2 chunks (nomic-embed-text-v2-moe:latest)
```

It reads `.xlsx`, `.xlsm`, `.md` and `.txt` files (`--ext`, `--exclude`).
Run it again whenever the documents change: files that did not change cost
nothing, and files that disappeared from the folder are removed from the
cache. The cache lives in
`.data/` (`--data` or `KC_DATA_DIR` changes that; use the same folder for
`ingest`, `kc:search` and `provision`, because the generated profiles point
the agent at the one they were generated with; likewise pass the same
`--ollama-url`, or set `OLLAMA_HOST`, when Ollama is not the local one).
`openclaw:generate` and `nas:scan` do not read `KC_DATA_DIR`: give them
`--data` themselves. To see how one workbook is read, run
`pnpm run excel:convert <file.xlsx>`.

### 4. Search the cache yourself

Before involving an agent, check that the cache answers:

```sh
pnpm run kc:search "maximum quantity of the cart"
```

```text
1. [0.504] design/notes.md
   design/notes.md > Release notes ⏎ The cart limit was raised to 99 ...

2. [0.239] design/basic-design.xlsx  (Screens!A1:D1, Screens!A2:D4)
   design/basic-design.xlsx > Screens ⏎ ### Screens!A1:D1 ⏎ ...
```

Each hit shows its score, the file and, for workbooks, the cell ranges.
`--k`, `--path` and `--sheet` narrow the search.

### 5. Start the two gateways

Each instance is an OpenClaw gateway with its own config, state folder and
port, listening on the loopback interface only. `provision apply` and
`openclaw:generate` print the exact lines for your shell, with the ports of
your profiles. Those below use the default ports (`19100` and `19300`); if
you chose others, use the printed lines instead. Use **one terminal per
gateway** and leave them open.

<details>
<summary>PowerShell</summary>

```powershell
# terminal 1: web
$env:OPENCLAW_CONFIG_PATH = "$PWD\.openclaw\web\openclaw.json"
$env:OPENCLAW_STATE_DIR = "$PWD\.openclaw\web\state"
openclaw gateway --port 19100

# terminal 2: knowledge
$env:OPENCLAW_CONFIG_PATH = "$PWD\.openclaw\knowledge\openclaw.json"
$env:OPENCLAW_STATE_DIR = "$PWD\.openclaw\knowledge\state"
openclaw gateway --port 19300
```

</details>

<details open>
<summary>POSIX shell</summary>

```sh
# terminal 1: web
OPENCLAW_CONFIG_PATH="$PWD/.openclaw/web/openclaw.json" \
OPENCLAW_STATE_DIR="$PWD/.openclaw/web/state" \
openclaw gateway --port 19100

# terminal 2: knowledge
OPENCLAW_CONFIG_PATH="$PWD/.openclaw/knowledge/openclaw.json" \
OPENCLAW_STATE_DIR="$PWD/.openclaw/knowledge/state" \
openclaw gateway --port 19300
```

</details>

Start the **knowledge** gateway from a shell in which `node -v` prints 26 or
later (for example inside `mise exec --`): its search skill runs
`pnpm run kc:search` with the `node` on that `PATH`.

### 6. Talk to the instances

The two variables above are what tells an `openclaw` command **which
instance** it talks to. Open a new terminal for each conversation and set
the same two variables as for that instance's gateway (the default
`~/.openclaw` profile is not one of ours). Then check the connection:

```sh
openclaw gateway health      # prints OK
openclaw agents list         # knowledge (default)   -- or research (default)
```

#### Terminal UI

`openclaw tui` opens a full-screen chat with the instance whose variables are
set. It takes the port and the token from that profile's config, so nothing
else has to be typed. Run it once per instance, in two terminals if you want
both at the same time.

<details>
<summary>PowerShell</summary>

```powershell
# terminal 3: knowledge
$env:OPENCLAW_CONFIG_PATH = "$PWD\.openclaw\knowledge\openclaw.json"
$env:OPENCLAW_STATE_DIR = "$PWD\.openclaw\knowledge\state"
openclaw tui

# terminal 4: web
$env:OPENCLAW_CONFIG_PATH = "$PWD\.openclaw\web\openclaw.json"
$env:OPENCLAW_STATE_DIR = "$PWD\.openclaw\web\state"
openclaw tui
```

</details>

<details open>
<summary>POSIX shell</summary>

```sh
# terminal 3: knowledge
OPENCLAW_CONFIG_PATH="$PWD/.openclaw/knowledge/openclaw.json" \
OPENCLAW_STATE_DIR="$PWD/.openclaw/knowledge/state" \
openclaw tui

# terminal 4: web
OPENCLAW_CONFIG_PATH="$PWD/.openclaw/web/openclaw.json" \
OPENCLAW_STATE_DIR="$PWD/.openclaw/web/state" \
openclaw tui
```

</details>

The first lines tell which instance you are in. For the knowledge instance:

```text
openclaw tui - ws://127.0.0.1:19300 - agent knowledge (Project knowledge) - session main
session agent:knowledge:main
gateway connected | idle
agent knowledge (Project knowledge) | session main | <model> | deliver:off | tokens ?/66k
```

and for the web instance `ws://127.0.0.1:19100`, `agent research`
(`Web research`) and `session agent:research:main`. Type a message and press
Enter. Local models are slow: on a small GPU an answer can take minutes, and
the status line shows `streaming` or `running` meanwhile.

Useful keys and commands (the full list is in the
[OpenClaw TUI guide](https://docs.openclaw.ai/web/tui)):

| Key or command  | What it does                                          |
| --------------- | ----------------------------------------------------- |
| `Enter`         | send the message (`Shift+Enter` adds a line)          |
| `Esc`           | abort the running answer                              |
| `Ctrl+O`        | show or hide the details of tool calls                |
| `/new`          | start a fresh session (the old one is kept)           |
| `/help`         | list the commands                                     |
| `Ctrl+D`        | leave (`Ctrl+C` twice does the same)                  |

#### Ask the knowledge instance

The knowledge instance has one skill, `knowledge-search`: it queries the
cache with `kc:search` and cites where each fact comes from. Local models do
not always pick a skill on their own (in one trial a plain question sent the
agent browsing the repository instead of searching the cache), so name the
skill at the start of the message:

```text
$knowledge-search What is the maximum quantity of the cart? Cite the file and the cell range.
```

OpenClaw makes the agent read the skill before it acts. The agent then runs
`kc:search` (press `Ctrl+O` to see the call) and answers from the hits. This
is a real answer of a 35B model on an 8 GiB GPU, after about two minutes:

```text
The maximum quantity of the cart is **99**.

Cited from:
- `design/basic-design.xlsx` (Screens!A2:D4) — Cart screen (SCR002): "The maximum quantity is 99."
- `design/notes.md` — "The cart limit was raised to 99 in release 2.4."
```

When the cache has nothing relevant, the skill tells the agent to say so
instead of inventing a specification, and to ask you to run `ingest` when the
cache looks out of date.

#### Ask the web instance

The web instance has the Web tools and nothing else: no shell, no file
writes, no cache. Ask it for what is on the Internet:

```text
Fetch https://example.com/ and tell me the title of the page and its first sentence.
```

```text
- **Title:** Example Domain
- **First sentence:** This domain is for use in documentation examples without needing permission.
```

The two instances do not talk to each other yet (the relay is tracked in
[#14](https://github.com/kurone-kito/oc-knowledge-cache/issues/14)). Carry
findings from the web instance into the knowledge instance by hand, and never
the other way round: what the knowledge instance returns can contain text
from the NAS documents or from the project repository, and must stay on this
machine.

#### Without the TUI

One question, answer printed, no screen takeover (set the variables of the
instance first, and name the agent of that instance):

```sh
openclaw agent --agent knowledge --timeout 900 --message "..."   # knowledge
openclaw agent --agent research --timeout 900 --message "..."    # web
```

To use a browser instead, `openclaw dashboard` opens the Control UI of the
gateway whose variables are set (by default `http://127.0.0.1:19300/` for the
knowledge instance, `19100` for the web instance); `--no-open` only prints
the address.

If you cannot set the variables, name the gateway and give its token. The
token is the `gateway.auth.token` value in the profile's `openclaw.json`;
typing it on a command line leaves it in your shell history and in process
lists, so prefer the variables. Use the port of that profile (`19300` and
`19100` unless you chose others):

```sh
openclaw tui --url ws://127.0.0.1:19300 --token <token>
```

The gateways listen on the loopback interface only, so `127.0.0.1` is the
machine you type this on. From another machine, forward the port first, for
example with `ssh -L 19300:127.0.0.1:19300 <host>`.

### 7. Keep it running

- **New, changed or deleted documents:** run
  `pnpm run ingest --source <share>` again (a scheduled task is fine). Only
  `ingest` is meant to write the data folder (`.data/` unless you chose
  another), but the knowledge agent has a shell and nothing stops it from
  doing so: make that folder read-only for the OS user that runs the
  gateways (see the limits in [docs/openclaw.md](docs/openclaw.md#limits)).
- **Is the machine still in order?** `pnpm run provision plan --check`, with
  the same options as for `apply`, exits with status 2 when something is
  missing, which suits a scheduled check.
- **Stop:** press `Ctrl+C` in the two gateway terminals.

### Troubleshooting

| What you see | Why and what to do |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| The agent browses the repository and never searches the cache, or says the cache is "not indexed" | It did not use its skill. Start the message with `$knowledge-search` (see above). |
| `No knowledge cache at .data/store.sqlite (run the ingest command first)` | `ingest` has not run for the data folder the profile uses (default `.data`), or the agent ran `kc:search` without the skill's settings. Run `pnpm run ingest --source <share>`, and pass the same `--out`, `--data`, `--project-repo` and `--ollama-url` to `provision` and `openclaw:generate` every time. |
| `Gateway not reachable at ws://127.0.0.1:19300 (ECONNREFUSED)` | The gateway is not running (it takes a while to start), or this terminal talks to another profile because the two variables are missing. |
| The TUI header shows another agent than you expected | Same cause: the variables of a different instance are set in this terminal. |
| `kc:search` fails inside the agent with a Node.js version error | The knowledge gateway was started with Node.js older than 26. Restart it from a shell where `node -v` prints 26 or later. |
| A gateway does not start because its port is taken | Run `pnpm run openclaw:generate` again with the same `--out`, `--data`, `--project-repo`, `--ollama-url` and `--model` as before, plus `--web-port <n> --knowledge-port <n>` (at least 120 apart), and start the gateways with those ports. |
| `provision plan` asks you to start Ollama | Start it, or look at its log: when Ollama answers with an error, the plan prints what it answered. |
| Answers take minutes | A large model on a small GPU is slow. Pick a smaller one with `--agent-model` (see `models:recommend`) and run `provision apply` again with the same options as before. |

## Commands

| Command                       | What it does                                  |
| ----------------------------- | --------------------------------------------- |
| `pnpm run models:recommend`   | rank the installed Ollama models for this PC  |
| `pnpm run provision`          | `plan` / `apply` what the machine is missing  |
| `pnpm run ingest`             | bring the cache in line with a folder         |
| `pnpm run kc:search`          | ask the cache from a terminal                 |
| `pnpm run nas:scan`           | dry run: what the next ingest would change    |
| `pnpm run excel:convert`      | show how one workbook is converted            |
| `pnpm run openclaw:generate`  | write the two profiles (what `apply` calls)   |

Run any command with `--help` for its options. The design is in
[docs/architecture.md](docs/architecture.md) and the two OpenClaw instances
are described in [docs/openclaw.md](docs/openclaw.md), including what their
isolation does not protect against.

## Development

### Install the dependencies

```sh
mise install
pnpm install
```

### Linting

```sh
pnpm run lint
pnpm run lint:fix # Lint and auto-fix
```

### Testing

```sh
pnpm run test
```

The command runs the linters (including the `tsc` typecheck) and then the
unit tests. Unit tests are `src/**/*.test.mts` files executed by the built-in
Node.js test runner; Node.js strips the types natively, so there is no build
step. Run only the unit tests with:

```sh
pnpm run test:unit
```

### Cleaning

```sh
pnpm run clean
```

## Contributing

Welcome to contribute to this repository! For more details,
please refer to [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

[MIT](./LICENSE)
