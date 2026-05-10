# Marketplace Assets — Index

This directory documents the visual assets required for each marketplace submission.
No binary files are stored here — all assets live in their canonical locations.
Export/convert as needed before submitting.

---

## Canonical Asset Locations

### Frihet MCP Repo (`~/Documents/frihet-mcp/`)

| File | Description | Use |
|------|-------------|-----|
| `assets/banner.svg` | Full-width banner, dark background | GitHub README hero, dark-mode |
| `assets/banner-light.svg` | Full-width banner, light background | GitHub README hero, light-mode |

### Frihet Saas Website (`~/Documents/Frihet-Saas-Website/public/`)

| File | Description | Dimensions | Use |
|------|-------------|------------|-----|
| `favicon.svg` | Frihet icon, monochrome | Vector | App icon for all marketplaces |
| `favicon-32x32.png` | Frihet icon, PNG | 32×32 | Favicon, small icon slots |
| `favicon-16x16.png` | Frihet icon, PNG | 16×16 | Favicon |
| `apple-touch-icon.png` | Apple touch icon | 180×180 | Mobile icon |
| `apple-touch-icon.svg` | Apple touch icon SVG | Vector | Mobile icon |
| `banners/frihet-banner-dev-github.png` | Dev-focused banner | 1280×640 approx | GitHub, Cursor marketplace |
| `banners/frihet-banner-dev-twitter.png` | Dev banner Twitter/X size | 1500×500 approx | Social promo |
| `banners/frihet-banner-dev-bluesky.png` | Dev banner Bluesky size | — | Social promo |
| `banners/frihet-banner-business-og.png` | Business-focused OG image | 1200×630 | OpenAI hero, OG tags |
| `banners/frihet-banner-business-linkedin.png` | Business banner LinkedIn | 1200×627 approx | Business-focused listings |
| `banners/frihet-banner-business-youtube.png` | YouTube thumbnail size | 1280×720 | Demo video thumbnail |

---

## Required Exports (Viktor action required before each submission)

### Anthropic Directory

- [ ] App icon PNG 512×512 — export `favicon.svg` → PNG
- [ ] 4× screenshots (1200×800 minimum) — see `anthropic/SUBMISSION.md` Section 6

### Cursor Marketplace

- [ ] Plugin icon PNG 128×128 — export `favicon.svg` → PNG at 128×128
- [ ] 3× screenshots — see `cursor/SUBMISSION.md` branding section

### OpenAI ChatGPT Apps

- [ ] App icon PNG 512×512 — export `favicon.svg` → PNG
- [ ] 4× screenshots (1200×800 minimum) — see `openai/SUBMISSION.md` Section 5

---

## SVG → PNG Export (macOS one-liner)

Requires `rsvg-convert` (Homebrew: `brew install librsvg`):

```bash
# 512×512 app icon
rsvg-convert -w 512 -h 512 ~/Documents/Frihet-Saas-Website/public/favicon.svg \
  > ~/Documents/frihet-mcp/marketplace/assets/frihet-icon-512.png

# 128×128 Cursor plugin icon
rsvg-convert -w 128 -h 128 ~/Documents/Frihet-Saas-Website/public/favicon.svg \
  > ~/Documents/frihet-mcp/marketplace/assets/frihet-icon-128.png
```

Or use Inkscape / Figma / any SVG viewer if rsvg-convert is not available.

---

## Screenshots — Capture Guide

All screenshots should show:
- Dark terminal or editor UI (consistent with Frihet brand: #171717 background)
- Real natural language input → structured response
- No personal NIF/IBAN/email in test data

Recommended capture tool: macOS Screenshot (`⌘⇧4`) + crop to 1200×800 or 1280×720.

---

## Demo Video Placeholder

A demo video (optional but recommended for all three marketplaces) showing:
1. Claude / ChatGPT / Cursor — "Create an invoice for [client], [items]"
2. Invoice created → structured response shown
3. "Show me unpaid invoices" → list appears
4. "Prepare my quarterly taxes Q1 2026" → Modelo 303 breakdown

Record with QuickTime or OBS. Upload to YouTube (unlisted) and reference the URL in submission forms.

**Status:** Not yet recorded. Viktor to record post-submission prep.
