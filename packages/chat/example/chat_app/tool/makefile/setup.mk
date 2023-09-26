.PHONY: splash icon

# https://pub.dev/packages/flutter_launcher_icons
icon:
	@fvm flutter pub run flutter_launcher_icons -f flutter_launcher_icons.yaml

# https://pub.dev/packages/flutter_native_splash
splash:
	@fvm flutter pub run flutter_native_splash:create --path=flutter_native_splash.yaml
