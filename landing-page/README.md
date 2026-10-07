# Searix Trade landing page

The original, editable website source lives in **`src/`**. This is a plain HTML, CSS and JavaScript site, using the mobile app's colors and locally bundled Plus Jakarta Sans fonts. No framework or npm dependencies are required.

## Project structure

```text
landing-page/
├── src/                       # Edit these files
│   ├── index.html             # Page content and sections
│   ├── styles.css             # Colors, fonts, layout and responsive styles
│   ├── app.js                 # Mobile navigation and fee calculator
│   └── assets/fonts/          # App font files and license
├── scripts/build.mjs          # Copies source into dist
├── dist/                      # Generated website; do not edit directly
├── package.json               # Development and build commands
└── .openai/hosting.json        # Existing Sites hosting configuration
```

## Develop

From this folder, run:

```bash
npm run dev
```

Open http://localhost:8080. Edit files in `src/` and refresh your browser to see changes. The development server requires Python 3. You can also open `src/index.html` directly in your browser.

## Build and preview

```bash
npm run check
npm run build
npm run preview
```

The build uses Node.js to copy `src/` into `dist/`, including local assets. Preview serves the generated site at http://localhost:8080; stop the development server first if it already uses this port. No `npm install` is necessary.

The generated `dist/` is retained for the existing static hosting setup. Always edit `src/` and rebuild before publishing.

## Product notes

The market screen contains clearly labeled illustrative values. The calculator uses the configured 15 bps standard fee as an example, not a live quote. Trading, wallet connection, sign-up submission and a public app download are not connected. Add a real download link when one is available.
