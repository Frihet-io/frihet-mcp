---
name: documentos
description: >-
  Prepare invoices and quotes for a connected Frihet workspace. Use for preparar
  factura, presupuesto, invoice draft, quote or quote conversion. Resolves missing
  client, currency and tax data before an authorized draft creation. Also use for
  invoice recovery after timeout, lost response or resultado desconocido al crear.
license: MIT
---

# Preparar documentos

Antes de usar herramientas, lee [las reglas de Frihet](../frihet-mcp/SKILL.md),
[el flujo de documentos](../frihet-mcp/references/workflows.md#documentos) y
[las comprobaciones fiscales](../frihet-mcp/references/tax-guide.md).

Presenta cliente, conceptos, cantidades, precios, moneda, impuestos y condiciones.
Distingue los datos verificados de los pendientes. No deduzcas impuesto nulo,
inversión del sujeto pasivo ni exención solo a partir del país del cliente.
Si faltan datos, prepara la propuesta y pide lo necesario antes de guardarla.

«Prepara una factura» pide una propuesta. «Crea el borrador con estos datos»
autoriza guardarlo cuando estén completos y el esquema los pueda representar;
no vuelvas a pedir una autorización ya dada. Crear un borrador no autoriza
emitir, enviar, cobrar ni presentar impuestos. Conserva el borrador y verifica
el resultado. Un timeout requiere buscar la creación anterior antes de repetir.
El hallazgo confirma la existencia y el estado del documento. Atribuye su creación
al intento anterior únicamente con una correlación fiable de la petición. Sin
ella, informa: «Existe un borrador coincidente; no puedo confirmar que lo creara
la petición que terminó en timeout».

Para una conversión, verifica el presupuesto, el vínculo existente y la capacidad
específica del servidor. No simules la conversión creando otra factura y cambiando
el estado del presupuesto. Indica el paso en Frihet si la operación no existe.
