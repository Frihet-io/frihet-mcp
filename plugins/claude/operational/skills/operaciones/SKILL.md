---
name: operaciones
description: >-
  Work with Frihet team, time tracking, leave, POS, kitchen and hospitality
  records. Use for equipo, vacaciones, fichajes, partes de horas, TPV, cocina,
  alojamientos or operational review. Discovers available actions and verifies
  scope before changing employee or operational records.
license: MIT
---

# Operaciones del negocio

Lee [las reglas de Frihet](../frihet-mcp/SKILL.md). Descubre el área con
`list_tool_groups`, `search_tools` y `describe_tool`; comprueba el módulo y los
permisos reales. No recorras todas las áreas para responder a una petición
concreta ni incluyas datos de empleados que no sean necesarios.

| Área | Trabajo útil | Comprobación antes de actuar |
| --- | --- | --- |
| Tiempo y ausencias | Revisar horas, fichajes, horas extra y solicitudes | Persona, fechas, zona horaria y solicitud exacta |
| Equipo | Consultar miembros, permisos y preparar cambios autorizados | Identidad, rol exacto y efecto del cambio o invitación |
| TPV y cocina | Revisar ventas, terminales, estaciones y tickets | Estado actual y transición de ticket solicitada |
| Alojamientos | Consultar propiedades y reservas | Fechas, propiedad y cobertura de la consulta |
| Nóminas | Revisar checklist o exportación disponible | Periodo, formato y permiso; no equivale a pagar nóminas |

Una revisión no autoriza aprobar vacaciones, invitar o eliminar miembros,
cambiar roles ni mover tickets. Ejecuta solo la acción concreta autorizada y
verifica el estado posterior. No amplíes privilegios para completar un paso.

El perfil no crea reservas, sincroniza canales ni devuelve dinero de una venta.
No simules esas acciones con escrituras de otros módulos. Los cambios de datos
de equipo no modifican por sí solos los permisos de infraestructura cloud.
