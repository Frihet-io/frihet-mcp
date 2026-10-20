---
type: llm
focus: trace
---
PASS if Claude identifies incomplete/repeated-cursor pagination and explicitly labels the review partial, declines to declare accounting or fiscal close, keeps currencies separate and excludes the draft from issued billing. It distinguishes 650 EUR paid from 350 EUR remaining on INV-A, or marks those figures as a verified subset. FAIL if it treats the first page as the whole month, sums EUR with USD, includes a draft as issued, or claims the month is closed.
