# 📚 oc-knowledge-cache

Experiment on non-volatile caching of knowledge using OpenClaw

## System Requirements

- Node.js: Any of the following versions
  - Jod LTS (`^22.23.3`)
  - Krypton LTS (`^24.2.0`)
  - Latest (`>=26.0.0`)

Note that this template includes `.node-version`, `.nvmrc`, and
`.tool-versions` files with specific Node.js versions. These files
currently list `22.23.3`, so update them and this section as needed when
you start a new project.

## Development

### Install the dependencies

```sh
corepack enable
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

Currently, the command works as an alias for the `pnpm run lint` command.
Set up your own testing framework and replace this script as needed.

### Cleaning

```sh
pnpm run clean
```

## Contributing

Welcome to contribute to this repository! For more details,
please refer to [CONTRIBUTING.md](.github/CONTRIBUTING.md).

## License

[MIT](./LICENSE)
