# CIB Analyzer — Static SPA

100% client-side SPA for Credit Analysts to process Bangladesh Bank CIB (Credit Information Bureau) PDF reports. Deployed on GitHub Pages at https://arko-01.github.io/cib-analyzer/

## Tech Stack

- **No build step, no backend** — plain ES modules served as-is
- **pdf.js 4.0** (CDN) — PDF text extraction
- **sql.js 1.10** (WASM, CDN) — SQLite in browser, persisted to IndexedDB
- **xlsx-js-style 1.2** (CDN) — Excel export with formatting
- **JSZip** — CSV ZIP bundling (optional, falls back to individual downloads)
- CDN scripts are loaded in `index.html` as globals (`pdfjsLib`, `initSqlJs`, `XLSX`, `JSZip`)

## Project Structure

```
static-app/
├── index.html          # Single HTML file, all pages in <section> tags
├── css/style.css       # Full stylesheet with dark/light theme via [data-theme]
├── js/
│   ├── app.js          # SPA router, page renderers, event handlers (~1400 lines)
│   ├── config.js       # Constants: risk tiers, classifications, colors, thresholds
│   ├── core/
│   │   ├── pdf-extract.js   # pdf.js wrapper, line reconstruction by Y-coordinate
│   │   ├── parser.js        # CIB PDF text → structured data (~2700 lines, largest file)
│   │   └── risk-engine.js   # 5-tier risk scoring: ADVERSE/HIGH/MODERATE/NO HISTORY/LOW
│   ├── db/
│   │   ├── database.js      # sql.js wrapper, CRUD, IndexedDB persistence (~1200 lines)
│   │   └── schema.js        # 15 tables + 3 views, indexes
│   └── exports/
│       ├── excel-export.js      # 10-sheet Excel (Master + Individual)
│       ├── individual-report.js # Thin wrapper, same template as Master
│       ├── csv-export.js        # 9 CSVs in ZIP
│       └── credit-memo.js       # Formatted credit assessment memo
└── lib/                # Empty — all deps via CDN
```

## Data Flow

```
PDF upload → pdf-extract.js → raw text lines
  → parser.js → structured report object
  → database.js → 15 SQLite tables (IndexedDB-backed)
  → risk-engine.js → risk rating + factors
  → app.js renders UI / exports generate files
```

## SPA Routing

Hash-based: `#/process`, `#/search`, `#/export`, `#/deal`, `#/log`. The router in `app.js` shows/hides `<section>` elements and calls page-specific render functions.

## Database Schema (15 tables)

Key tables: `subjects`, `inquiries`, `summary_snapshots`, `contracts`, `monthly_history`, `linked_subjects`, `relationships`, `non_funded`, `classification_matrix`, `external_debt`, `alert_flags`, `processing_log`, `batches`. See `js/db/schema.js` for full DDL.

`getSubjectFull(cibCode)` returns everything: subject + inquiries + summary_snapshots + contracts (with nested monthly_history + linked_subjects) + non_funded + relationships + classification_matrix + external_debt + alert_flags.

## Export System

All three export types (Master Excel, Individual Report, CSV) share `collectData()` in `excel-export.js` which calls `getSubjectFull()` per subject and flattens into 9 data arrays. The 10-sheet Excel template and 9-CSV structure are identical in schema.

## Parser Gotchas

These are the hardest-won lessons from testing with real PDFs:

- **`###` masked codes**: Other banks' FI codes, branch codes, and contract codes appear as `###`. Must be accepted as valid values.
- **`\ufb01` ligature**: pdf.js outputs the `fi` ligature character in "Confidential". `cleanAndSplit()` normalizes it.
- **Multi-line facility names**: "Term" and "Loan" split across lines. Post-processing in `parseSingleContract()` rejoins them.
- **Interleaved columns**: Contract metadata (left) and monthly history (right) merge into single lines. The parser uses heuristics to split.
- **Date format**: All dates are `DD/MM/YYYY`. String sorting requires conversion to `YYYYMMDD`.
- **Willful Default line splits**: "Willful Default" and "(WD)" or "(Appeal)" may be on separate lines in the classification matrix.
- **Variable column counts**: 2025+ reports have 5 facility types (incl. "Non-Listed securities"), older ones have 4.
- **Subject type formats**: Some PDFs have `Type of subject: INDIVIDUAL` (colon), others `Type of subject Individual` (no colon).
- **Inquiry header**: Can be multi-line or single-line format.

## Risk Scoring (5 tiers)

1. **ADVERSE**: Any DF/BL/BLW classification, or willful default (Yes/WD)
2. **HIGH RISK**: SS classification, NPI >= 6, rescheduled >= 2 times
3. **MODERATE**: SMA classification, NPI >= 1
4. **NO HISTORY**: No contracts found
5. **LOW RISK**: Everything else

## Testing

7 test PDFs at `../cib_output/processed_pdfs/` (use the ones without `(2)` or `(3)` suffix):
- `1061503650001-3.pdf` — Individual, Guarantor only, 7 contracts (MST ROWSAN ARA)
- `1121502646701.pdf` — Company, 2 living contracts (GREENPLAST RECYCLING LIMITED)
- `12415023475.pdf` — Individual with 3 proprietorships, 20 contracts (GOPENDRA CHANDRA PAUL)
- `1271503459801.pdf` — Public Ltd, 159 contracts, largest file (Leo ICT Cables PLC)
- `170013941068.pdf` — Individual, no facilities (MD. ABU TAHER)
- `CIB(1).pdf` — Individual, no facilities (MD. JEWEL RANA)
- `CIB.pdf` — Individual, all terminated (MD. TIPU SULTAN)

To test locally: `npx http-server static-app -p 5000 -c-1` (configured in `.claude/launch.json` as `cib-web`).

## Common Tasks

- **Fix parser mismatch**: Compare extracted PDF text (use pdfplumber) against what `parser.js` produces. The parser has section-boundary detection in `findSectionBoundaries()` and per-section parsers.
- **Add a DB field**: Update `schema.js` DDL → update `database.js` INSERT/SELECT → update `parser.js` to extract → update `app.js` to render → update export files to include.
- **Modify exports**: Edit `excel-export.js` — all three export types use `collectData()` + `buildWorkbook()`.
