---
name: cobros
description: >-
  Review available invoice list records and draft reminder text in conversation.
  Use for cobros pendientes, impagos, receivables or payment follow-up in Frihet.
  Separates currencies and marks balances unknown when the list lacks evidence.
  This consultation profile cannot send, collect or change records.
license: MIT
---

# Consulta de cobros pendientes

Lee [las reglas de consulta](../frihet-mcp/SKILL.md) y
[el flujo de cobros](../frihet-mcp/references/workflows.md#cobros-pendientes).

Define la fecha de corte y consulta las páginas pertinentes de facturas. No
limites la cartera solo al estado vencido: puede haber facturas enviadas o con
pagos parciales. Conserva cada estado, fecha, moneda y campo de saldo recibido.
Si no hay evidencia suficiente de pagos, abonos y saldo, escribe «saldo
desconocido»; no sustituyas el saldo por el total original ni inventes una
herramienta de detalle. Señala cualquier cobertura parcial.

Entrega una tabla con referencia o ID, cliente, vencimiento, días vencidos,
saldo verificado o desconocido y moneda. Separa vencido de no vencido y agrupa
solo importes comparables por moneda. Prioriza únicamente saldos verificados.
Puedes redactar recordatorios en la conversación; si falta el saldo, prepara
un texto neutral que pida comprobarlo sin afirmar una deuda concreta.

Este perfil no envía recordatorios, marca pagos, concilia ni modifica clientes.
Indica los pasos pendientes en la aplicación. No afirmes que un borrador del
chat se guardó y no escales automáticamente a reclamaciones legales.
