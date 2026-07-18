# Spanish Tax Guide for Frihet

Complete tax reference for business operations in Spain. Used by the Frihet MCP skill to apply correct tax rates, categorize expenses, and prepare quarterly filings.

## Tax Types by Fiscal Zone

### IVA (Impuesto sobre el Valor Añadido) — Peninsula + Balearic Islands

| Rate | Percentage | Applies to |
|------|-----------|------------|
| General | 21% | Most goods and services |
| Reduced | 10% | Food, transport, hospitality, water, housing renovation |
| Super-reduced | 4% | Bread, milk, eggs, fruit, vegetables, books, medicine, wheelchairs |
| Exempt | 0% | Medical services, education, insurance, financial services |

**Modelo 303** — Quarterly IVA return:
- IVA repercutido (collected on sales) minus IVA soportado (paid on deductible purchases)
- Positive result → pay to AEAT
- Negative result → compensate in next quarter or request refund (annual only via Modelo 390)

**Modelo 390** — Annual IVA summary (filed with Q4, deadline Jan 30).

### IGIC (Impuesto General Indirecto Canario) — Canary Islands

| Rate | Percentage | Applies to |
|------|-----------|------------|
| General | 7% | Most goods and services |
| Reduced | 3% | Food, transport |
| Zero | 0% | Basic necessities, education, health |
| Increased | 9.5% | Certain luxury goods |
| Special increased | 13.5% / 20% | Tobacco, alcohol |

**Modelo 420** — Quarterly IGIC return (equivalent to 303 but filed with ATC, not AEAT).

IMPORTANT: Canarias is NOT part of the EU VAT territory. Businesses in Canarias charge IGIC, never IVA.

### IPSI (Impuesto sobre la Producción, los Servicios y la Importación) — Ceuta & Melilla

General rate: 10%. Less common — only applies to businesses physically located in Ceuta or Melilla.

### EU Reverse Charge (Inversión del Sujeto Pasivo)

When invoicing B2B to another EU country:
- Tax rate: 0%
- Invoice must include: "Inversión del sujeto pasivo" / "Reverse charge — Art. 196 Directive 2006/112/CE"
- Client must have valid EU VAT number (verify via VIES)
- Report in Modelo 349 (Intra-community operations, quarterly)

### Rest of World (Exportaciones)

When invoicing outside the EU:
- Tax rate: 0% (exempt)
- No tax line on invoice
- Mark as export/exempt in Frihet

## IRPF (Impuesto sobre la Renta de las Personas Físicas)

Applies ONLY to professional services invoiced B2B within the peninsula. Not applicable to product sales or international invoices.

| Situation | Retention Rate |
|-----------|---------------|
| Standard professional | 15% |
| New autónomo (first 3 years) | 7% |
| Artists, authors (first 2 years) | 7% |
| Agricultural activities | 2% |
| Livestock activities | 1% |

**How it works on invoices:**
```
Base imponible:        1,000.00 EUR
IVA 21%:               + 210.00 EUR
IRPF 15%:              - 150.00 EUR
───────────────────────────────────
Total factura:         1,060.00 EUR
```

**Modelo 130** — Quarterly IRPF prepayment:
- 20% of net income (income minus deductible expenses) for the quarter
- Or simplified: 20% of net result, cumulative YTD minus previous payments

## Quarterly Tax Calendar

| Quarter | Period | Filing Window | Models |
|---------|--------|--------------|--------|
| Q1 | Jan-Mar | Apr 1-20 | 303 (IVA), 130 (IRPF), 420 (IGIC if Canarias) |
| Q2 | Apr-Jun | Jul 1-20 | 303, 130, 420 |
| Q3 | Jul-Sep | Oct 1-20 | 303, 130, 420 |
| Q4 | Oct-Dec | Jan 1-30 | 303, 130, 420, 390 (annual IVA summary) |

**Additional annual models:**
- **Modelo 347** — Operations over 3,005.06 EUR with a single counterpart (Feb 1-28)
- **Modelo 349** — Intra-community operations summary (quarterly or monthly if >50K)
- **Modelo 180** — Annual rent withholdings summary (Jan 1-31)
- **Modelo 190** — Annual IRPF withholdings summary (Jan 1-31)

## Expense Deductibility Rules

### Fully Deductible (100%)

| Category | Examples |
|----------|---------|
| Office supplies | Paper, ink, stationery |
| Software/SaaS | Subscriptions, licenses, hosting, domains |
| Professional services | Gestoría, abogado, notario, consulting |
| Marketing | Advertising, design, campaigns, SEO, social media |
| Training | Courses, conferences, books (related to business activity) |
| Business insurance | Civil liability, business property |
| Office rent | Dedicated workspace (100%) |
| Bank fees | Business account fees, transaction costs |

### Partially Deductible

| Category | Limit | Notes |
|----------|-------|-------|
| Vehicle fuel | 50% | For autónomos using personal vehicle for business |
| Vehicle expenses | 50% | Maintenance, insurance, parking (same rule) |
| Meals (domestic) | 26.67 EUR/day | Must be paid electronically, business-related |
| Meals (international) | 48.08 EUR/day | Same electronic payment requirement |
| Phone/Internet | % business use | Typically 50-70%, must justify |
| Home office | % of home area | Calculate m2 of office / total m2, apply to rent/mortgage + utilities |
| Vehicle purchase | 50% IVA deductible | Unless exclusively business use (prove it) |

### NOT Deductible

- Personal expenses, clothing (unless uniform/PPE)
- Fines and penalties
- Donations (not deductible for autónomos, some exceptions for corporations)
- Entertainment without clear business purpose
- Cash payments over 1,000 EUR (not deductible regardless of category)

### Cash Payment Limit

Spain has a 1,000 EUR cash payment limit for transactions involving a business. Payments above this amount must be electronic/traceable to be tax deductible. This limit is 10,000 EUR for non-residents.

## VeriFactu (Mandatory Certified Invoicing)

- **What:** All invoices must be digitally signed, chained (hash), and reported to AEAT in real-time or near-real-time.
- **Corporations (sociedades):** Mandatory from January 1, 2027
- **Autónomos:** Mandatory from July 1, 2027
- **Frihet status:** VeriFactu-compliant. Certified invoicing built in.

## Crea y Crece (B2B Electronic Invoicing)

- **What:** Mandatory electronic invoicing for all B2B transactions in Spain.
- **Large companies (>8M EUR revenue):** 2027
- **All companies:** 2028
- **Format:** Facturae 3.2.2 (Spanish standard) or compatible
- **Frihet status:** Supports electronic invoice generation and export.

## Fiscal Zone Detection

When a client's address is provided, determine fiscal zone:

| Location | Zone | Tax System |
|----------|------|-----------|
| Any Spanish province except Canarias/Ceuta/Melilla | `peninsula` | IVA |
| Las Palmas, Santa Cruz de Tenerife | `canarias` | IGIC |
| Ceuta, Melilla | `ceuta_melilla` | IPSI |
| Any EU country (with valid VAT number) | `eu` | Reverse charge |
| Non-EU country | `world` | Exempt |

**Spanish province codes for peninsula:** A Coruña, Álava, Albacete, Alicante, Almería, Asturias, Ávila, Badajoz, Barcelona, Burgos, Cáceres, Cádiz, Cantabria, Castellón, Ciudad Real, Córdoba, Cuenca, Girona, Granada, Guadalajara, Guipúzcoa, Huelva, Huesca, Illes Balears, Jaén, La Rioja, León, Lleida, Lugo, Madrid, Málaga, Murcia, Navarra, Ourense, Palencia, Pontevedra, Salamanca, Segovia, Sevilla, Soria, Tarragona, Teruel, Toledo, Valencia, Valladolid, Vizcaya, Zamora, Zaragoza.
