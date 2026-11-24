# Configuración

`local.env.example` es la única plantilla versionable. Cópiala a un archivo
privado por ambiente:

```text
local.env
linux.env
nimbus.env
idce.env
```

Los archivos reales están excluidos por `.gitignore`. No reutilices URLs,
usuarios ni credenciales entre ambientes sin validación.

`users.example.json` documenta el formato del pool. Los archivos reales se
nombran `users.<ambiente>.json`, tienen permisos `600` y nunca se versionan.
