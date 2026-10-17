# Frihet ERP para Claude

Consulta y gestiona tu negocio de Frihet desde Claude. Este plugin incluye
flujos para revisar cobros pendientes, preparar facturas y presupuestos y hacer
una revisión mensual. También permite otras gestiones mediante las operaciones
que ofrezca el MCP conectado. Trabaja en español o inglés y distingue una
propuesta de un cambio guardado, un envío y una aceptación fiscal.

## Versión de prueba

Este paquete está configurado para el candidato remoto de Claude,
`https://claude-mcp.frihet.io/mcp`. El despliegue y OAuth alojado aún no están
verificados; no lo instales como una integración disponible hasta completar
esas comprobaciones.
Su catálogo, versión y permisos dependen del servidor y de tu cuenta; los skills
no filtran las herramientas del servidor ni amplían tus permisos. El paquete es
una versión de prueba y no acredita aprobación de Anthropic ni disponibilidad
en su directorio. El conector y el plugin deben presentarse desde la misma organización de Claude
y con este mismo endpoint, después de verificarlo.

## Instalación

En Claude Code, carga la carpeta del plugin para una sesión:

```bash
claude --plugin-dir ./plugins/claude/frihet-erp
```

En chat y Cowork, añade el ZIP de esta carpeta desde **Customize → Plugins →
Add → Upload plugin**. Abre la pestaña **Connectors** del plugin y conecta Frihet
mediante el inicio de sesión que muestre Claude. Necesitas una cuenta de Frihet
con acceso a las operaciones solicitadas y que tu plan u organización permita
plugins y conectores. No pegues credenciales en la conversación. Si ya tienes
Frihet conectado, selecciona la conexión existente cuando Claude lo permita.
Evita mantener dos conexiones al mismo negocio en una sesión.

## Peticiones que puedes hacer

- «Revisa los cobros vencidos; separa las monedas y redacta recordatorios».
- «Prepara un presupuesto con estos conceptos e identifica los datos que faltan».
- «Revisa septiembre y señala lo cobrado, lo pendiente y los gastos sin validar».

En Claude Code puedes invocar `/frihet-erp:cobros`, `/frihet-erp:documentos`,
`/frihet-erp:revision-mensual` o `/frihet-erp:frihet-mcp`. En chat los skills también
se aplican cuando tu petición encaja. Una revisión o una propuesta no ejecuta
escrituras. Puedes autorizar una acción concreta cuando sus datos están completos;
crear un borrador no autoriza enviarlo ni emitirlo fiscalmente.

## Qué usa y adónde van los datos

El paquete contiene un manifiesto, configuración del MCP remoto y archivos de
instrucciones. No instala ejecutables, hooks ni procesos locales. Las llamadas
MCP envían los parámetros necesarios a `claude-mcp.frihet.io`; el servidor accede a la
API de Frihet para el negocio autorizado y devuelve resultados a Claude. El
inicio de sesión utiliza el flujo OAuth anunciado por ese servidor. Los skills
no piden exportar registros a otros servicios.

Las respuestas del perfil Claude omiten los campos de la política de redacción
compartida, incluidos identificadores fiscales, IBAN, secretos, `documentNumber`
y `verifactuHash`. La redacción se aplica también a los recursos JSON y al texto
de respuesta generado a partir de los datos saneados. Este perfil no ofrece las
descargas de PDF ni de archivos de factura electrónica, cuyo contenido no puede
sanearse con esa redacción de campos. Evita incluir datos sensibles en texto
libre: la redacción por campos no es un detector universal de información personal.

Anthropic recibe los parámetros y resultados MCP de tus peticiones bajo las
condiciones de tu cuenta de Claude. Cloudflare gestiona OAuth y sesiones;
Firebase Authentication verifica tu identidad y el backend de Google Cloud
procesa los registros de Frihet. El perfil Claude desactiva Langfuse. Las
escrituras del backend pueden enviar eventos completos a PostHog EU y
notificaciones mediante Novu, además de correo, webhooks o envíos fiscales
configurados; revisa esos efectos antes de autorizar una acción. El [contrato de
observabilidad](https://github.com/Frihet-io/frihet-mcp/blob/main/docs/observability.md)
limita la telemetría a metadatos operativos; no contiene entradas ni salidas de
herramientas ni credenciales. Consulta la [privacidad](https://www.frihet.io/es/privacy)
y las [condiciones](https://www.frihet.io/es/terms) para el tratamiento del servicio.

Los informes dependen de datos y páginas disponibles; señalan cobertura parcial,
monedas desconocidas y saldos sin verificar. No sustituyen una revisión contable
ni deciden automáticamente impuestos, deducibilidad o aceptación fiscal.

Documentación: https://docs.frihet.io/desarrolladores/mcp-server.
Soporte: hola@frihet.io. Licencia MIT.
