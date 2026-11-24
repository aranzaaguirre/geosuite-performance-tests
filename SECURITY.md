# Seguridad

## Información sensible

No se deben versionar:

- archivos `config/*.env` reales;
- pools `config/users.*.json`;
- claves PEM, tokens, cookies o certificados privados;
- resultados que contengan datos reales;
- credenciales administrativas de Keycloak o GeoServer.

Las configuraciones y pools privados deben tener permisos `600`.

## Ejecución segura

- Confirmar que el ambiente no sea producción.
- Obtener autorización antes de carga, estrés, picos o aprovisionamiento.
- Usar cuentas exclusivas y con privilegios mínimos.
- No utilizar `--insecure-skip-tls-verify`.
- Definir condiciones de detención y monitorear CPU, RAM y reinicios.
- Ejecutar `UPLOAD_MODE=full` únicamente de forma funcional y controlada.

## Reporte de incidentes

No abras un issue público con secretos o datos personales. Reporta el
hallazgo por el canal interno del equipo y rota cualquier credencial expuesta.
