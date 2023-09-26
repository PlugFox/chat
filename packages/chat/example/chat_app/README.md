# Chat App

## Code generation

```bash
$ make codegen
```

## Localization

```bash
$ code lib/src/common/localization/intl_en.arb
$ make intl
```

## Recreating the project

**! Warning: This will overwrite all files in the current directory.**

```bash
fvm spawn beta create --overwrite -t app --project-name "chatapp" --org "dev.plugfox.chat" --description "The Chat App" --platforms ios,android,windows,linux,macos,web .
```
