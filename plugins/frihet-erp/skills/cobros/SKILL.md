---
name: cobros
description: >-
  Review pending and overdue invoices in a connected Frihet workspace. Use for
  cobros pendientes, impagos, morosos, antigüedad de saldos, enlaces de cobro,
  receivables or payment follow-up. Verifies partial payments and currencies,
  retrieves server-authoritative portal payment links when available, and drafts reminders.
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
Separa lo vencido de lo todavía no vencido. Muestra saldos desconocidos (`null`,
nunca convertidos en `0`) y cobertura parcial. Propón prioridades dentro de cada
moneda y redacta recordatorios cuando se soliciten. No escales automáticamente a
amenazas o reclamaciones legales.

## Obtener enlace de cobro frente a enviar o registrar pago

Cuando el usuario pida *«Dame el enlace para cobrar esta factura y dime qué queda pendiente»*:
- Comprueba el catálogo conectado y sus esquemas antes de buscar un enlace de cobro. Si el perfil anuncia una operación dedicada y autorizada, usa únicamente el enlace, saldo, moneda y estado de cobrabilidad que devuelva el servidor. Si no existe esa operación o deniega el acceso, indica que el enlace no está disponible en esta conexión; no inventes nombres de herramientas, rutas ni tokens, ni cambies de conexión para eludir la limitación.
- **No reconstruyas saldos** sumando campos legacy en el cliente ni conviertas un saldo desconocido (`unknown_degraded` / `null`) en `0`.
- **Obtener el enlace no cobra ni envía:** devolver `authorizedPortalUrl` concede acceso limitado al portal de pago (donde la cobrabilidad y el saldo se revalidan al abrir y pagar), pero **no envía ningún correo** (`send_invoice`), **no inicia un cargo ni crea reservas de fondos**, **no marca la factura como pagada** (`mark_invoice_paid`) y **no ejecuta conciliación bancaria** (`match_transaction_to_invoice`).

Un informe, un enlace de cobro o un borrador de recordatorio no autoriza envíos,
marcas de pago, conciliaciones, devoluciones ni cambios en clientes. El envío,
el registro manual de un cobro, el reembolso y la conciliación siguen siendo
operaciones separadas con sus permisos y confirmaciones reales.
