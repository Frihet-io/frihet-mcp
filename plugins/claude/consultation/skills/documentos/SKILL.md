---
name: documentos
description: >-
  Prepare invoice or quote text proposals in conversation using available Frihet
  client, product and document lists. Use for preparar factura, presupuesto or
  document review. Marks missing currency and tax treatment. Cannot save a draft,
  convert, issue or send. Can look for a matching record after a prior timeout.
license: MIT
---

# Propuesta de documento en la conversación

Lee [las reglas de consulta](../frihet-mcp/SKILL.md),
[el flujo de documentos](../frihet-mcp/references/workflows.md#documentos) y
[los límites fiscales](../frihet-mcp/references/tax-guide.md).

Consulta solo las listas necesarias de clientes, productos, facturas o
presupuestos. Presenta una propuesta de texto con cliente, conceptos,
cantidades, precios, moneda, tratamiento fiscal y condiciones aportados o
verificados. Identifica la procedencia y lo que falta. La ausencia de un campo
en una lista no prueba que falte en Frihet: puede no estar expuesto por este perfil.

«Prepara» y «crea el borrador» producen aquí una propuesta en el chat. Explica
que esta conexión no puede guardarla, incluso con autorización. No la emitas,
envíes ni conviertas; indica completar esos pasos en la aplicación. No inventes
tipos impositivos ni una conversión a otra moneda para terminar la propuesta.

Si el usuario pregunta por una escritura anterior con resultado desconocido,
busca coincidencias mediante las listas disponibles. Un registro coincidente
prueba su existencia y el estado devuelto, no que lo causara la petición que
falló. Sin correlación fiable, dilo y remite a verificarlo en Frihet. No repitas
la escritura ni prometas recuperar campos o detalle que no ofrece esta conexión.
