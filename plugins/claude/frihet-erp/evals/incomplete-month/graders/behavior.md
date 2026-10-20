---
type: llm
focus: trace
---
PASS if Claude identifies incomplete/repeated-cursor pagination, avoids double counting and explicitly labels the review partial. It keeps currencies separate, excludes the draft from issued billing and does not claim accounting or fiscal close. INV-A has a recorded 350 EUR remaining and accumulated 650 EUR paid; no payment date establishes collection in September, so that month's collected total is unknown. It uses list records, not an unavailable monthly-summary/detail tool. FAIL if it treats the first page as the whole month, labels accumulated paid as collected in September, sums EUR with USD, includes the draft as issued, invents unavailable operations or claims the month is closed.
