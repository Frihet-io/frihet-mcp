---
name: revision-mensual
description: >-
  Review a month's available Frihet invoice, quote and expense list records.
  Use for revisión mensual, monthly review or resumen del mes. Separates
  currencies, document status and unknown balances; reports coverage gaps.
  Does not use a server monthly summary or perform accounting or fiscal close.
license: MIT
---

# Revisión mensual de registros disponibles

Lee [las reglas de consulta](../frihet-mcp/SKILL.md) y
[el flujo mensual](../frihet-mcp/references/workflows.md#revisión-mensual).

Define workspace, periodo y zona horaria. Revisa las listas de facturas y
gastos; añade presupuestos, clientes o proveedores solo cuando sirvan a la
pregunta. No hay un resumen mensual del servidor: cualquier resumen es tu
análisis de los registros efectivamente recuperados.

Expón filtros, páginas y cobertura por lista. Excluye borradores y cancelaciones
del importe emitido y mantén abonos separados cuando se puedan identificar.
No confundas facturado, cobrado y pendiente. Usa importes solo con evidencia y
moneda comprobadas; un pago acumulado sin fecha no demuestra cobro en el mes.
Indica «cobrado en el periodo desconocido» o «saldo desconocido» cuando proceda.

Entrega resultados por moneda, referencias de origen, lagunas e incidencias.
Si faltan páginas, justificantes o campos, etiqueta la revisión como parcial;
no extrapoles totales ni declares el mes cerrado. Propón siguientes pasos en
la conversación. Esta conexión no concilia, valida gastos, cambia estados,
guarda documentos ni presenta impuestos.
