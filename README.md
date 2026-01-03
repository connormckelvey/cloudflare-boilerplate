# Cloudflare Boilerplate

A Turborepo monorepo for publishing open source npm libraries under the `@cloudflare-boilerplate` scope.

## Structure

This monorepo is organized for publishing npm libraries. Each library should be placed in the `packages/` directory.

## Getting Started

### Install Dependencies

```bash
npm install
```

### Build

Build all packages:

```bash
npm run build
```

### Lint

Lint all packages:

```bash
npm run lint
```

### Test

Run tests for all packages:

```bash
npm run test
```

## Adding a New Library

1. Create a new directory in `packages/` with your library name
2. Initialize a package.json with the scope `@cloudflare-boilerplate/your-library-name`
3. Add build, lint, and test scripts to your package.json
4. Turborepo will automatically detect and manage the new package

## Publishing

Each package can be published independently to npm. Make sure you're logged in to npm and have the appropriate permissions for the `@cloudflare-boilerplate` scope.

```bash
cd packages/your-library
npm publish --access public
```

