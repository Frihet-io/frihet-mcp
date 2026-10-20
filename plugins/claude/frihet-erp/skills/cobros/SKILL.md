---
name: cobros
description: >-
  Review pending and overdue invoices in a connected Frihet workspace. Use for
  cobros pendientes, impagos, morosos, antigüedad de saldos, receivables or payment
  follow-up. Verifies partial payments and currencies, then drafts reminders.
license: MIT
---

# Cobros pendientes

Antes de usar herramientas, lee [las reglas de Frihet](../frihet-mcp/SKILL.md)
y [el flujo de cobros](../frihet-mcp/references/workflows.md#cobros-pendientes).
Si Frihet no está conectado, indica el paso de conexión sin pedir credenciales.

Obtén una cartera verificable a la fecha de corte: recorre todas las páginas,
comprueba el saldo después de pagos y abonos y agrupa por moneda. Para importes
aportados por el usuario, identifica la procedencia y los datos que faltan;
no afirmes que has consultado Frihet si no lo has hecho.

Entrega una tabla con factura, cliente, vencimiento, días vencidos, saldo y moneda.
Separa lo vencido de lo todavía no vencido. Muestra saldos desconocidos y cobertura
parcial. Propón prioridades dentro de cada moneda y redacta recordatorios cuando
se soliciten. No escales automáticamente a amenazas o reclamaciones legales.

Un informe o un borrador de recordatorio no autoriza envíos, marcas de pago,
conciliaciones, devoluciones ni cambios en clientes. Para enviar, comprueba el
contenido y destinatario con el usuario y la capacidad real de la herramienta.
