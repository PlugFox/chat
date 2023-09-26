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

## Authentication

### Google Sign-In

Add credential at [Google Console](https://console.cloud.google.com/apis/credentials)

For Android, use [web related client id](https://github.com/flutter/flutter/issues/20903#issuecomment-1735878336).

#### How to generate `keystore.jks`

Windows

```bash
keytool -genkey -v -keystore ~/android/keystore.jks -storetype JKS -keyalg RSA -keysize 2048 -validity 50000 -alias release
```

Mac

```bash
keytool -genkey -v -keystore ~/android/keystore.jks -storetype JKS -keyalg RSA -keysize 2048 -validity 50000 -alias release
```

#### How to get info from `keystore.jks`

Debug

```bash
keytool -list -v -keystore debug.keystore -alias androiddebugkey -storepass android -keypass android
```

Release

```bash
keytool -list -v -keystore ./android/keystore.jks -alias release
```
