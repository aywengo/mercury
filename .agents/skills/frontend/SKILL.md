---
name: frontend
version: 1.1.0
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
4. escape all dynamic content (esc()) to prevent XSS -- **but esc() is not enough for URLs**
5. validate URL schemes with `safeUrl()` before putting a value in `href`. esc() neutralises the
   characters that break out of an attribute, and `javascript:alert(1)` uses none of them: it is a
   well-formed attribute value whose *scheme* is the payload. Any value that reaches `href` or
   `src` and did not originate in this codebase (an agent event, a repository field, an API
   string) needs `safeUrl()`, plus `rel="noopener noreferrer"` on any `target="_blank"`.
6. keep the UI usable without JavaScript errors on older browsers

Accessibility:

- semantic HTML elements, labels on inputs
- keyboard-operable controls
- sufficient color contrast

Before completion, report:

- files changed
- how the change was verified in a browser
- any deviations from the existing UI conventions
