# Datos de prueba de rendimiento

`upload-pilot.csv` es un archivo pequeño, sintético y sin datos personales.
Se utiliza en el modo seguro `analyze` de `04-upload.js`.

Contiene tres registros y cuatro columnas: nombre, latitud, longitud y valor.
Las coordenadas permiten validar la detección `latlon`, la previsualización y
la publicación vectorial sin depender de archivos reales del proyecto.

El escenario crea un job temporal del importador, espera el análisis de
columnas, solicita una previsualización geográfica y elimina únicamente ese
job. No crea un dataset de GeoNode salvo que se use explícitamente
`UPLOAD_MODE=full`.

El modo `full` crea un dataset persistente, comprueba que GeoNode entregue su
detalle y valida que GeoServer sirva la nueva capa mediante WMS y WFS. El
dataset no se elimina automáticamente; su identificador queda en la salida
para revisarlo y retirarlo después desde la interfaz administrativa.

## Prerrequisito de publicación

Antes de usar `UPLOAD_MODE=full`, la credencial `GEOSERVER_ADMIN_USER` /
`GEOSERVER_ADMIN_PASSWORD` cargada por Django y Celery debe ser válida contra
la API REST interna de GeoServer. El volumen persistente de GeoServer puede
conservar una contraseña anterior aunque se haya cambiado el archivo `.env`.

Un `401 Unauthorized` dentro de `GeoNode execution` indica un problema de esa
comunicación interna y no un fallo de la sesión Keycloak simulada por k6. En
ese caso se deben reconciliar las credenciales sin borrar el volumen ni los
recursos publicados.

Un error `Failed to publish feature type` acompañado de un fallo de conexión
PostGIS indica que la contraseña persistida en el datastore de GeoServer no
coincide con `GEONODE_GEODATABASE_PASSWORD`. Esa configuración pertenece a la
infraestructura y no debe trasladarse a los archivos de k6.
