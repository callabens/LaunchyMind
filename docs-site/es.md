# LaunchyMind (Español)

LaunchyMind revisa un proyecto móvil antes de enviarlo a la App Store o a Google Play. El veredicto es **listo**, **arriesgado** o **rechazo probable**. Solo el motor de reglas lo decide. No es una aprobación de la tienda ni asesoramiento legal.

## Instalación

Node.js 22.18 o posterior. Desde una copia del repositorio:

```bash
npm install
npm run build
node dist/apps/cli/src/index.js scan ruta/a/la/app --offline
```

## Inicio rápido

```bash
launchymind scan ruta/a/la/app --lang es
launchymind explain ruta/a/la/app --why-not-ready
launchymind init ruta/a/la/app --set attestations.apple.xcode-sdk=true
```

`--offline` omite las comprobaciones de red. Un dato que falta queda **sin comprobar**, y sin comprobar impide el veredicto listo. Nunca se rellena una respuesta en blanco por ti.

## Idioma

`--lang es` elige español. Sin `--lang`, decide la primera variable definida entre `LC_ALL`, `LC_MESSAGES` y `LANG`; si no hay ninguna, el idioma de VS Code; si no, inglés. Compatibles: en, tr, de, fr, es, pt-BR, it, ja, ko, zh-Hans, ar, ru.

Las fuentes de las reglas se citan en su idioma original. Los términos de las tiendas, como App Store Connect, Play Console, App Privacy y Data safety, se mantienen tal como las tiendas los escriben. Una explicación sin traducción al español se muestra en inglés con una nota.
