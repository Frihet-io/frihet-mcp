# Frihet para Claude

Gestiona tu negocio desde una conversación: consulta facturas y clientes,
prepara presupuestos, registra gastos y trabaja con tus movimientos bancarios.
El plugin combina el MCP remoto de Frihet con guías para completar tareas,
verificar lo guardado y mostrar qué queda pendiente.

## Qué puedes hacer

| Necesidad | Ejemplo de petición | Resultado esperado |
| --- | --- | --- |
| Facturas y presupuestos | «Prepara el presupuesto para este cliente con los conceptos acordados» | Propuesta completa; guardado en borrador cuando lo autorices |
| Cobros | «Revisa los vencimientos y redacta los recordatorios» | Saldos verificados por moneda y textos preparados |
| Gastos y proveedores | «Registra este gasto con estos datos» | Registro verificado, con importe, fecha e ID |
| Bancos | «Revisa los movimientos y propone conciliaciones» | Correspondencias, dudas y diferencias; cambios concretos cuando los autorices |
| CRM | «Ponme al día sobre este cliente y guarda esta nota» | Contexto de sus registros y nota guardada con verificación |
| Revisión mensual | «Cómo fue septiembre y qué debería resolver» | Resumen con cobertura, incidencias y próximos pasos |
| Operaciones | «Revisa las horas del equipo o los tickets pendientes» | Lectura del módulo y acciones específicas según permisos |

El perfil operativo contiene 125 operaciones de negocio en once áreas: documentos,
gastos, fiscalidad disponible, banca, CRM, equipo y tiempo, alojamientos, TPV y
cocina, inteligencia, catálogo y plataforma. Cuatro alias fiscales y tres
herramientas de descubrimiento completan los 132 nombres del modo agrupado.
No necesitas aprender sus nombres: describe la tarea y las skills seleccionan
las herramientas disponibles en tu conexión.

## Conectar y empezar

1. Instala el plugin y conecta el servidor Frihet incluido mediante OAuth.
2. Inicia sesión con la cuenta de Frihet y el workspace al que quieres acceder.
   No pegues claves ni tokens en la conversación.
3. Empieza con una consulta concreta. Por ejemplo: «Resume mi negocio este mes
   y dime qué facturas requieren atención». Revisa la cobertura y los datos
   pendientes antes de decidir cambios.

El MCP es la conexión y sus herramientas; las ocho skills son guías para usarlas.
Puedes pedir la tarea en lenguaje natural o invocar `frihet-mcp`, `documentos`,
`cobros`, `gastos`, `tesoreria`, `clientes`, `revision-mensual` y `operaciones`
dentro del plugin `frihet-erp`. No sustituyen el plan ni los permisos de Frihet.

## Cambios claros y resultados comprobados

Una revisión o propuesta no guarda ni envía nada. Una instrucción concreta puede
ya autorizar una acción: el plugin no debe pedir la misma autorización de nuevo
si el alcance y los datos están claros. Los borradores se conservan como tales;
pueden recibir numeración y generar eventos configurados. Los envíos, cambios de
equipo, recurrencias y operaciones fiscales requieren su alcance específico.

Los importes se separan por moneda. Una factura parcialmente pagada requiere
comprobar su saldo; la primera página de una lista no representa todo el negocio.
Los creadores actuales de facturas, presupuestos y gastos expresan importes en
EUR: una propuesta en otra divisa necesita una operación que pueda representarla.
Una escritura con resultado desconocido se consulta antes de repetirla.

El catálogo excluye transferencias de dinero, operaciones diferidas, rutas de
factura electrónica no disponibles para esta conexión, determinados borrados y
artefactos PDF/XML que no puedan sanearse. Conciliar o registrar un pago no
mueve fondos. Una revisión fiscal no equivale a presentar ni garantiza aceptación
por una autoridad. El detalle de cada herramienta determina sus efectos reales.

## Datos y soporte

El paquete aporta instrucciones y la conexión remota; no instala ejecutables,
hooks ni procesos locales. Anthropic recibe los parámetros y resultados de las
herramientas bajo las condiciones de tu cuenta. Cloudflare gestiona OAuth y
sesiones; Firebase Authentication verifica la identidad y el backend de Google
Cloud procesa los registros de Frihet. El host Claude desactiva Langfuse.

Las escrituras pueden generar eventos de negocio en PostHog EU, notificaciones
por Novu, envíos o webhooks según la operación y la configuración del workspace.
Revisa esos efectos antes de autorizarlos. Los resultados de Claude omiten campos
sensibles de la política compartida, incluidos identificadores fiscales, IBAN,
secretos, `documentNumber` y `verifactuHash`. El texto libre puede contener otros
datos personales: utiliza solo los necesarios.

[Documentación](https://docs.frihet.io/desarrolladores/mcp-server) ·
[Soporte](https://claude-mcp.frihet.io/support) ·
[Privacidad](https://www.frihet.io/es/privacy) ·
[Condiciones](https://www.frihet.io/es/terms) ·
[Contacto](mailto:contact@frihet.io)

## Estado de esta versión

`1.18.0-preview.4` es el candidato operativo para distribución. El control de
admisión del piloto sigue separado del alcance del producto. Instalar el paquete
no abre el acceso a cuentas nuevas ni acredita que el catálogo esté desplegado.
La disponibilidad pública y la inclusión en los directorios de Anthropic requieren
el despliegue, la aceptación del catálogo completo y sus respectivos envíos.
