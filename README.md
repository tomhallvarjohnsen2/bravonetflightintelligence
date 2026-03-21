# BravoNET Flight Intelligence

Live air traffic map built with React, TypeScript, Vite, and OpenLayers.

## Local development

```bash
npm install
npm run dev
```

## Production build

```bash
npm run build
```

## GitHub Pages deployment

This repository is configured for GitHub Pages at:

`https://tomhallvarjohnsen2.github.io/bravonetflightintelligence/`

Deployment is handled by `.github/workflows/deploy.yml` and runs automatically on pushes to `main`.

To publish:

1. Create or use the GitHub repository `tomhallvarjohnsen2/bravonetflightintelligence`.
2. Push this project to the `main` branch.
3. In GitHub, open `Settings` -> `Pages` and ensure the site is using `GitHub Actions`.
4. Wait for the `Deploy to GitHub Pages` workflow to complete.

After that, the app will be available on the URL above.
