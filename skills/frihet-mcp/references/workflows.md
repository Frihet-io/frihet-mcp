# Flujos de trabajo de Frihet

Aplica primero las reglas de SKILL.md y el contrato del servidor conectado.
Los nombres siguientes son ejemplos canónicos; descubre su equivalente agrupado
si el servidor lo usa. Un flujo no autoriza todas sus escrituras.

## Cobros pendientes

1. Define fecha de corte y empresa. Lee list_invoices con los filtros admitidos y
   completa la paginación. Incluye pagos parciales; no dependas únicamente de una
   etiqueta overdue. Usa get_invoice cuando falten vencimiento, moneda o saldo.
2. Obtén el saldo pendiente comprobado tras pagos y abonos. Excluye borradores,
   documentos cancelados y saldos no positivos del total de cobros exigibles.
   Separa vencidos, todavía no vencidos y datos desconocidos. Ordena por antigüedad
   y por saldo dentro de cada moneda, sin comparar monedas como si fueran iguales.
3. Muestra documento, cliente, vencimiento, saldo y moneda; totales por moneda,
   registros pendientes de verificar y cobertura de páginas. Prepara recordatorios
   únicamente como texto. Si se solicita un envío, comprueba que la herramienta
   disponible envía ese contenido, y valida destinatario, texto y autorización.
   send_invoice puede enviar la factura y no un recordatorio personalizable;
   no lo uses como sustituto si su contrato no lo admite.

## Documentos

1. Resuelve cliente y documento de origen; recupera contexto, conceptos, cantidades,
   precios, moneda y condiciones. Revisa el tratamiento fiscal en tax-guide.md.
   No supongas la moneda ni los impuestos por la ubicación del cliente.
2. Presenta la propuesta con los campos conocidos y pendientes. «Prepara» no
   implica crear. Para una creación autorizada, usa create_invoice o create_quote
   con estado draft si su esquema lo permite; si la moneda requerida no se puede
   representar en el contrato actual, no guardes en la moneda por defecto.
3. Verifica ID, estado y cantidades devueltos. Si se pierde la respuesta, consulta
   el estado antes de cualquier reintento. Para convertir un presupuesto, busca
   una operación explícita de conversión que preserve el vínculo y comprueba si
   ya existe una factura asociada. Si no está disponible, completa la conversión
   desde Frihet; no crees una factura copiando conceptos y alterando el presupuesto.

## Revisión mensual

1. Define mes, empresa y zona horaria. Usa get_monthly_summary cuando esté
   disponible, comprobando qué incluye. Lee invoices y expenses del periodo con
   todas sus páginas cuando necesites detalle o contrastar la cobertura.
2. Separa facturación emitida de borradores y cancelaciones, base de impuestos,
   cobrado de pendiente y abonos de ingresos originales. Usa los importes y estados
   reales. No trates el total de una factura parcialmente pagada como cobrado o
   pendiente. Identifica gastos faltantes o sin validar y evita duplicar registros.
3. Presenta por moneda las métricas que puedas verificar y los documentos que las
   sustentan. Una diferencia aritmética entre facturas y gastos no acredita cierre
   contable, beneficio neto ni impuestos a presentar. Si la cobertura es parcial,
   no concluyas que el mes está cerrado. Propón acciones sin ejecutarlas.

## Otros flujos

Para clientes, productos, gastos y otros dominios, prepara los datos necesarios,
resuelve duplicados, muestra el cambio y respeta la autorización concreta. En un
lote, conserva el resultado individual de cada registro y señala fallos parciales.
La clasificación propuesta de un gasto requiere el catálogo real de categorías;
no garantiza deducibilidad. Una revisión no incluye modificar categorías,
conciliar movimientos, enviar documentos ni ejecutar recurrencias.
