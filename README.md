# Rewind Any Web

Reverse a URL or screenshot into a practical frontend reconstruction kit:

- source scaffold: React and CSS generated from the captured page model
- style guide: typography, color tokens, spacing, radii, and interaction notes
- Figma payload: a JSON layer tree that a Figma plugin can recreate as frames, text, and shapes
- Figma/developer handoff: a reusable prompt/spec for building new pages in the same visual language

## Run

```bash
npm install
npx playwright install chromium
npm run dev
```

Open `http://127.0.0.1:5173`.

## First sample

Use `https://x.ai` in the URL field. The API will render the page with Playwright, capture a screenshot, extract visible DOM nodes and computed styles, then generate the source/style/Figma outputs from that model.

Screenshot uploads work without a browser. They infer palette, canvas size, visual density, and a Figma-friendly frame scaffold from the image pixels.

## Authenticated pages

URL mode can replay a logged-in session for sites that require authentication without manually pasting cookies:

1. Check **Use browser login state**.
2. Click **Open login window**.
3. Log in to the target site in the opened Chromium window.
4. Keep the login window available for the most reliable current-session capture.
5. Run **Reverse** with **Use browser login state** still checked.

The app stores a local Playwright browser profile under `.rewind-sessions/` so cookies and localStorage can be reused for future captures of the same site. This directory is git-ignored.

The app cannot automatically read cookies from your normal browser for another domain. Browsers intentionally block that. A future browser extension could make that exact current-browser handoff smoother.

## AI usage

This MVP does not require AI to run. URL mode relies on browser rendering, DOM extraction, computed CSS, screenshot capture, and deterministic generation. Screenshot mode relies on pixel sampling and layout heuristics.

AI is the next useful layer when you want:

- OCR and component semantics from screenshots
- more human naming for layers and components
- richer product-page planning from visual evidence
- higher-fidelity source code from ambiguous layouts

The `figma-developer-handoff.md` output is designed to bridge that gap today: it turns the captured style into a reusable Figma and developer spec so a team can build new pages in the same style without copying the original page verbatim.
