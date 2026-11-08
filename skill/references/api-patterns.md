# Patrones de uso de la API

## El esquema conectado es el contrato

Consulta las herramientas del MCP conectado. Un nombre puede tener prefijo del
servidor o estar agrupado con una acción. Usa exactamente los campos, enum,
restricciones y metadatos descubiertos; los ejemplos de este skill no sustituyen
el esquema. No llames operaciones ausentes, diferidas o no disponibles.

Lee el contexto de negocio si está disponible y es necesario. Para buscar un
cliente, empieza por una búsqueda acotada; si hay varios resultados, resuelve la
identidad antes de escribir. No expongas identificadores fiscales o bancarios
completos si el usuario no los necesita.

## Lecturas y páginas

Usa filtros y selección de campos cuando el esquema los permita. Conserva los
filtros entre páginas, sigue nextCursor con el parámetro declarado y detente al
agotarlas. Si el contrato usa offset, avanza según el tamaño devuelto. Detecta
cursores repetidos y registros duplicados; un resultado truncado no está completo.
No inventes límites de páginas ni garantías de exhaustividad.

Para importes, comprueba moneda y significado: base, impuestos, total original,
pagos, abonos y saldo pendiente son cantidades distintas. Usa get_invoice u otra
lectura de detalle cuando esté disponible. No rellenas un dato ausente con cero.

## Escrituras

Comprueba la autorización y los datos antes de la llamada. Usa un borrador cuando
la operación lo permita. Descubre si hay idempotencyKey y su alcance; no añadas
campos inventados ni presupongas que todos los endpoints son idempotentes.
Conserva la misma clave para el mismo intento lógico si el contrato lo garantiza.
Verifica el ID y estado devueltos antes de anunciar que se guardó el cambio.

## Errores y resultados desconocidos

- Autenticación o permisos: indica que la conexión o los permisos requieren
  revisión en Frihet/Claude. No pidas credenciales en la conversación.
- Validación: identifica el campo que falta; no completes la solicitud con un
  valor supuesto para hacer que pase.
- Límite temporal de peticiones: respeta el tiempo indicado por el servidor.
  Una lectura puede repetirse dentro de un límite razonable; una escritura
  requiere comprobar antes el resultado y su idempotencia.
- Timeout, conflicto o error después de enviar una escritura: resultado
  desconocido. Busca el registro o consulta su estado; no crees otro para probar.
- Fallo a mitad de un flujo: enumera los pasos confirmados y los pendientes.
  No ejecutes una compensación destructiva ni afirmes que hubo rollback.
