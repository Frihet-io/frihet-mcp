# Flujos de consulta

Aplica siempre las reglas del skill principal. Todas las propuestas y textos
permanecen en la conversación; ninguna de estas guías guarda ni envía registros.

## Cobros pendientes

Define fecha de corte, workspace y zona horaria. Consulta `list_invoices` sin
restringir la cartera al estado vencido; recorre las páginas disponibles y
selecciona los estados relevantes sin confundir borrador o cancelado con deuda.
Una factura enviada o parcial también puede tener saldo vencido.

Comprueba el saldo y su moneda en los campos devueltos. El total original no es
el saldo; pagos y abonos pueden cambiarlo. Si no se puede comprobar, informa
«saldo desconocido» y propone verificarlo en la aplicación. No existe una
herramienta de detalle que complete estos datos en este perfil.

Separa vencidos y no vencidos por moneda, con referencias de origen y cobertura.
Redacta recordatorios solo en el chat. No afirmes una deuda concreta a partir
de un saldo desconocido, no inventes destinatarios y no afirmes haber enviado nada.

## Documentos

Usa `list_clients`, `list_products`, `list_quotes` o `list_invoices` solo cuando
ayuden a la propuesta. No asumas que una lista contiene todos los campos de un
documento. Pregunta por cliente exacto, conceptos, cantidades, precios, moneda,
tratamiento fiscal, fechas o condiciones que no se puedan verificar.

Entrega un texto revisable y señala los datos pendientes. Incluso si el usuario
pide crear, convertir, emitir o enviar, explica que esta versión solo consulta
y que debe completar esa acción en Frihet. No presenta impuestos ni calcula
un tratamiento fiscal basándose únicamente en país o dirección.

Tras un timeout anterior, una coincidencia en la lista demuestra solo existencia
y estado observados. Sin correlación fiable no la atribuyas a la llamada fallida;
no prometas detalle ni reintentes esa escritura.

## Revisión mensual

Define periodo y zona horaria. Recorre `list_invoices` y `list_expenses` con los
filtros declarados; añade otras listas únicamente si la pregunta lo necesita.
No hay resumen mensual del servidor en esta versión.

Separa emitido, borrador y cancelado. No llames «cobrado en el mes» a un importe
pagado acumulado si no hay fecha del cobro que lo sustente. Presenta saldos solo
cuando estén respaldados y separa monedas. Si faltan páginas, campos o
justificantes, muestra un subconjunto verificado y la revisión como parcial.

Entrega referencias, cobertura, incidencias y siguientes pasos en el chat.
Nunca declares un cierre contable o fiscal, conciliaciones ni validaciones de
gastos a partir de estas listas.
