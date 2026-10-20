# Frihet ERP para Claude

Consulta clientes, facturas, presupuestos, gastos, proveedores y productos de tu
workspace de Frihet. Prepara propuestas de texto y recordatorios en la
conversación. Esta primera versión de consulta no guarda borradores, envía
mensajes, cambia registros, cobra ni presenta impuestos.

## Versión de consulta en preparación

El paquete `1.18.0-preview.3` usa `https://claude-mcp.frihet.io/mcp` y está diseñado
para nueve herramientas: seis listas de negocio y tres de descubrimiento.
Incluye cuatro skills, ningún prompt MCP y un recurso de formatos de divisas.
Los skills no añaden herramientas ni amplían permisos. El catálogo general del
MCP y otros perfiles conservan sus propias operaciones.

El endpoint remoto y OAuth se comprobaron con una cuenta QA sintética el
20 de octubre de 2026. Esa prueba anterior utilizó un catálogo más amplio;
no acredita el despliegue ni la aceptación completa de este nuevo catálogo de
consulta. Su publicación requiere comprobar la versión desplegada, sus nueve
herramientas y los recorridos con datos QA poblados. Este paquete no acredita
presentación, aprobación de Anthropic ni disponibilidad en Claude Directory.
El conector y el plugin deben presentarse desde la misma organización de Claude
y con este mismo endpoint, después de completar esas comprobaciones.

## Instalación

En Claude Code, carga la carpeta del plugin para una sesión:

```bash
claude --plugin-dir ./plugins/claude/frihet-erp
```

En chat y Cowork, añade el ZIP de esta carpeta desde **Customize → Plugins →
Add → Upload plugin**. Abre **Connectors** y conecta Frihet mediante el inicio de
sesión que muestre Claude. El acceso al piloto requiere una identidad QA
habilitada; no está abierto a todas las cuentas. Tu plan u organización de
Claude también debe permitir plugins y conectores. No pegues credenciales en
el chat. Si ya tienes Frihet conectado, usa la conexión existente cuando Claude
lo permita y evita conexiones duplicadas al mismo negocio.

## Peticiones de ejemplo

- «Revisa los registros de cobros vencidos, separa monedas y señala saldos desconocidos».
- «Prepara aquí un texto de presupuesto con estos conceptos y marca lo que falta».
- «Revisa las facturas y gastos disponibles de septiembre e indica la cobertura».

En Claude Code puedes invocar `/frihet-erp:cobros`, `/frihet-erp:documentos`,
`/frihet-erp:revision-mensual` o `/frihet-erp:frihet-mcp`. En chat los skills pueden
aplicarse por lenguaje natural. Una propuesta permanece en la conversación;
para guardarla, convertirla, emitirla o enviarla, completa el paso en Frihet.

## Superficie y límites

Las consultas de negocio son `list_clients`, `list_invoices`, `list_quotes`,
`list_expenses`, `list_vendors` y `list_products`. `list_tool_groups`, `search_tools`
y `describe_tool` descubren sus contratos y no ejecutan las operaciones descritas.
El único recurso, `frihet://config/currencies`, ofrece ejemplos de formato,
no cambios de divisas ni precisión de pagos. No hay lectura de detalle individual,
resumen mensual del servidor, descargas ni herramientas de escritura.

Los informes exponen filtros, páginas y registros revisados. Una paginación
incompleta implica cobertura parcial; una moneda ausente queda fuera de sumas.
El total de una factura no prueba su saldo ni su cobro. Si los registros no
respaldan pagos, abonos y saldo, se informa «saldo desconocido». Un importe pagado
sin fecha no demuestra un cobro en el periodo. Las revisiones no sustituyen un
cierre contable ni deciden deducibilidad o aceptación fiscal.

## Datos y servicios

El paquete contiene un manifiesto, configuración del MCP remoto e instrucciones.
No instala ejecutables, hooks ni procesos locales. Las llamadas MCP envían los
parámetros necesarios a `claude-mcp.frihet.io`; el servidor consulta la API de
Frihet para el workspace autorizado y devuelve resultados a Claude. Las skills
no piden exportar registros a otros servicios.

El perfil Claude omite los campos de la política de redacción compartida,
incluidos identificadores fiscales, IBAN, secretos, `documentNumber` y
`verifactuHash`, también en recursos JSON y texto generado desde datos saneados.
No ofrece descargas de PDF ni archivos de factura electrónica. Evita incluir
datos sensibles en texto libre: la redacción por campos no detecta toda la
información personal.

Anthropic recibe parámetros y resultados bajo las condiciones de tu cuenta de
Claude. Cloudflare gestiona OAuth y sesiones; Firebase Authentication verifica
tu identidad y el backend de Google Cloud consulta los registros de Frihet.
El perfil Claude desactiva Langfuse. Este catálogo no ejecuta escrituras ni sus
efectos de correo, cobro, webhooks o envíos fiscales. El [contrato de
observabilidad](https://github.com/Frihet-io/frihet-mcp/blob/main/docs/observability.md)
limita la telemetría a metadatos operativos; no incluye entradas, salidas ni
credenciales de las herramientas. Consulta la
[privacidad](https://www.frihet.io/es/privacy) y las
[condiciones](https://www.frihet.io/es/terms) del servicio.

Documentación: https://docs.frihet.io/desarrolladores/mcp-server.
Soporte: hola@frihet.io. Licencia MIT.
