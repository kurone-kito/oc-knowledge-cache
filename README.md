# 📚 oc-knowledge-cache

Experiment on non-volatile caching of knowledge using OpenClaw

## System Requirements

- Node.js: Latest (`>=26.0.0`)
- mise-en-place

## Usage

The pipeline needs [Ollama](https://ollama.com) with a chat model that supports
tool calling and an embedding model (`pnpm run models:recommend` shows what fits
this machine).

```sh
pnpm run ingest --source <NAS share>   # scan, convert, embed and store
pnpm run kc:search "<question>"          # ask the cache
pnpm run openclaw:generate              # write the two OpenClaw profiles
```

Run any command with `--help` for its options. The design is in
[docs/architecture.md](docs/architecture.md) and the two OpenClaw instances
are described in [docs/openclaw.md](docs/openclaw.md).

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
