# Contribución

## Principios

- No incrustar URLs, IDs, tokens o contraseñas en escenarios.
- Modelar diferencias de ambiente mediante variables documentadas.
- Mantener los escenarios funcionales antes de aumentar carga.
- Usar datos sintéticos y operaciones recuperables.
- Separar defectos funcionales de degradación de rendimiento.

## Antes de enviar cambios

1. Ejecuta `k6 inspect --include-system-env-vars` sobre el escenario.
2. Ejecuta el perfil `functional` en un ambiente autorizado.
3. Verifica que no se incluyan secretos ni resultados.
4. Actualiza `docs/SCENARIOS.md` si cambia el flujo.
5. Documenta cualquier nueva variable en `config/local.env.example`.

## Convenciones

- Nombres de checks en español y con prefijo del escenario.
- Tags mínimos: `scenario` y `operation`.
- Funciones compartidas en `lib/`; no duplicar autenticación.
- Líneas base en `results/<ambiente>/`, nunca en Git.
- `UPLOAD_MODE=full` solo con `TEST_PROFILE=functional`.
