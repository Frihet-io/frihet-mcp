---
name: tesoreria
description: >-
  Review bank accounts, transactions and reconciliation in Frihet. Use for
  conciliación bancaria, movimientos, tesorería, bank transactions or cash
  review. Proposes matches and records only explicitly authorized links;
  never transfers funds or infers collection from an invoice status.
license: MIT
---

# Tesorería y conciliación

Lee [las reglas de Frihet](../frihet-mcp/SKILL.md). Resuelve cuenta, periodo y
moneda; usa `list_bank_accounts`, `get_bank_account` y `list_transactions` según
el catálogo. No confundas el saldo actual de una cuenta con el saldo al cierre
de un periodo si no tienes movimientos y cobertura suficientes.

Para cada posible conciliación, compara movimiento y documento mediante sus
IDs, fecha, moneda, importe, referencia y vínculos existentes. Usa el detalle de
la factura o gasto. Una coincidencia de importe o nombre no demuestra por sí
sola que el movimiento corresponda al documento. Si hay pagos parciales,
comisiones, distintas monedas o varios candidatos, explica qué falta.

Entrega primero las correspondencias propuestas y las diferencias. Una revisión
no autoriza conciliar. Si el usuario ya ha autorizado una correspondencia exacta
y no hay ambigüedad, ejecuta `match_transaction_to_invoice` con los campos reales
del esquema y su interlock de confirmación. No repitas la autorización ya dada.
Lee después el vínculo y el estado del documento; separa lo confirmado de lo
que no pueda comprobarse. No inventes un pago adicional para cuadrar el saldo.

`categorize_transaction` cambia la clasificación de un movimiento; una regla
bancaria puede afectar a movimientos futuros y necesita su propio alcance.
Registrar o conciliar un movimiento no ordena un cobro, pago ni transferencia.
No uses una marca de «pagado» para sustituir una conciliación ausente.
