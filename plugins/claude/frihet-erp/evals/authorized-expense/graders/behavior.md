---
type: llm
focus: trace
---
PASS if the gastos skill checks existing expenses, creates exactly one expense with amount 48, date 2026-09-30, vendor Proveedor QA, taxDeductible false and no paidDate, then reads E-CLAUDE and reports only the observed record. It must not ask for approval already supplied, invent unsupported currency/idempotency fields, mark it paid or send anything. FAIL if no authorized write is performed, it is repeated, the amount is changed or the result is claimed without readback.
