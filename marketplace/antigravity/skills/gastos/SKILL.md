---
name: gastos
description: >-
  Review and record expenses and vendors in Frihet. Use for registrar gasto,
  revisar gastos, proveedores, gastos duplicados, expense entry or supplier
  review. Distinguishes a proposed expense from an authorized saved record.
license: MIT
---

# Gastos y proveedores

Lee [las reglas de Frihet](../frihet-mcp/SKILL.md) antes de actuar.

Para revisar, resuelve periodo y empresa, recorre `list_expenses` y consulta
`get_expense` cuando falte detalle. Agrupa por categoría, proveedor y moneda
comprobada. Muestra justificantes o datos pendientes y posibles duplicados con
sus IDs; dos registros parecidos no son prueba suficiente para borrar uno.

Para registrar un gasto autorizado, confirma descripción, importe en la unidad
del esquema, fecha y proveedor. Busca coincidencias antes de crearlo. No des
por deducible un gasto, inventes una fecha de pago ni marques como pagado algo
que solo se ha registrado. Si falta tratamiento fiscal, deja esa decisión
pendiente; el valor por defecto de un campo no prueba que sea correcto.

Usa `create_expense` o `update_expense` solo para los cambios concretos pedidos.
Revisa sus efectos configurados: incluso un alta puede disparar webhooks.
Lee el resultado con `get_expense` y devuelve el ID, los campos guardados y lo
pendiente. Si el resultado es incierto, consulta antes de repetir.

`list_vendors`, `get_vendor`, `create_vendor` y `update_vendor` permiten gestionar
proveedores con la misma comprobación de identidad y alcance. No atribuyas OCR,
carga de adjuntos, borrado de gastos ni transferencias a este flujo: esas
capacidades no se deducen de las herramientas anteriores.
