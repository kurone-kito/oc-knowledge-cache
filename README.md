# 📚 oc-knowledge-cache

Experiment on non-volatile caching of knowledge using OpenClaw

## System Requirements

- Node.js: Latest (`>=26.0.0`)
- mise-en-place

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
