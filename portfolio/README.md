# Nik Behrendt — Portfolio

Statische One-Page-Portfolio-Website (Kameramann · Drohnenpilot · AI Artist).
Kein Build-Step, keine Dependencies — nur `index.html`, `style.css`, `script.js`.

## Lokal ansehen

```bash
npx serve portfolio
# oder einfach portfolio/index.html im Browser öffnen
```

## Hosten

Der Ordner kann 1:1 auf jeden statischen Host (GitHub Pages, Netlify, nginx,
oder als zusätzliche Route im Express-Server) gelegt werden.

## Anpassen

- **Kontakt-E-Mail**: in `index.html` nach `mailto:` suchen.
- **Projekte/Arbeiten**: die `.work`-Karten in `index.html` — Platzhalter
  durch echte Thumbnails/Vimeo-Links ersetzen.
- **Zahlen im Über-Bereich**: `data-count`-Attribute.
- **Farben**: CSS-Variablen oben in `style.css` (`--accent` usw.).
