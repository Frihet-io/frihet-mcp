# Comprobaciones fiscales para documentos de Frihet

Esta guía sirve para recoger datos y revisar evidencia del negocio. No contiene
tipos, calendarios, reglas de deducibilidad ni garantías de cumplimiento que
puedan aplicarse automáticamente.

## Antes de preparar una factura

Comprueba emisor y configuración fiscal, identidad y condición del destinatario,
naturaleza del bien o servicio, lugar de realización, fecha de la operación,
moneda y tratamiento fiscal autorizado. Recupera esos datos de Frihet cuando
estén disponibles. Una dirección o un número de IVA por sí solos no determinan
el tratamiento. Un cliente de la UE puede ser una empresa o un consumidor;
ninguno justifica automáticamente un impuesto nulo. Lo mismo se aplica a clientes
fuera de la UE y a operaciones entre territorios españoles.

Si faltan datos para IVA, IGIC, IPSI, inversión del sujeto pasivo, exención o
retención, prepara el resto del documento y pide el dato pendiente antes de
guardarlo. No uses el tipo por defecto del servidor como una decisión fiscal.
No extrapoles el impuesto de una factura anterior a una operación distinta.

## Gastos e informes

La categoría de un gasto no prueba su deducibilidad. Separa lo registrado de lo
validado fiscalmente; conserva documentos y criterios suministrados por el
negocio. Un cálculo de impuestos de ingresos menos gastos no es una declaración
lista para presentar. Si una herramienta devuelve un modelo o resumen fiscal,
indica el periodo, régimen, procedencia, advertencias y estado que devuelve.
No estimes pagos anteriores, deducciones ni casillas que faltan.

## Emisión, rectificación y presentación

Consulta la operación concreta disponible, sus requisitos y sus efectos. Un
borrador o una exportación no acredita emisión, envío ni aceptación fiscal.
No manipules estados para evitar el flujo fiscal. Para rectificar, verifica el
documento original, el motivo, el alcance permitido y la autorización antes de
crear otro registro. No inventes modalidades de rectificación que la API no
admita. Un reenvío o reintento fiscal también necesita comprobar el resultado
previo para evitar duplicidades.

Para fechas, normas o tipos vigentes, consulta la fuente oficial aplicable a la
operación y registra qué comprobaste. Si no puedes verificarlo, explica la duda
y pide el tratamiento validado por el negocio o su asesoría.
