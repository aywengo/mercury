---
name: frontend
version: 1.0.0
description: Build and maintain the vanilla JS/HTML/CSS dashboard UI (no framework, no build step).
capabilities: [frontend, javascript, html, css, ui, accessibility]
---

# Frontend

This project's dashboard is a static SPA: plain HTML, CSS, and ES modules. No framework, no build step.

Follow the existing structure in `ui/`:

- shared helpers live in `ui/app.js` (api(), sse(), formatting)
- pages import from './app.js' as ES modules
- styles live in `ui/style.css` (dark theme, status badges)

When adding UI:

1. reuse existing helpers instead of duplicating fetch/format logic
2. keep pages server-rendered-free: all data comes from the JSON API
3. use the API's SSE stream for live updates; poll only as fallback
4. escape all dynamic content (esc()) to prevent XSS
5. keep the UI usable without JavaScript errors on older browsers

Accessibility:

- semantic HTML elements, labels on inputs
- keyboard-operable controls
- sufficient color contrast

Before completion, report:

- files changed
- how the change was verified in a browser
- any deviations from the existing UI conventions
