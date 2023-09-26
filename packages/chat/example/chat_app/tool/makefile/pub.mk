.PHONY: version doctor clean get codegen intl upgrade upgrade-major outdated dependencies format

# Check flutter version
version:
	@fvm flutter --version

# Check flutter doctor
doctor:
	@fvm flutter doctor

# Clean all generated files
clean:
	@rm -rf coverage .dart_tool .packages pubspec.lock

# Get dependencies
get:
	@fvm flutter pub get

# Generate code
codegen: get
	@fvm flutter pub run build_runner build --delete-conflicting-outputs
	@dart pub global run intl_utils:generate
	@dart format --fix -l 120 .

# Generate intl messages
intl:
	@dart pub global run intl_utils:generate
	@dart format --fix -l 120 .

# Generate all
gen: codegen

# Upgrade dependencies
upgrade:
	@fvm flutter pub upgrade

# Upgrade to major versions
upgrade-major:
	@fvm flutter pub upgrade --major-versions

# Check outdated dependencies
outdated: get
	@fvm flutter pub outdated

# Check outdated dependencies
dependencies: upgrade
	@fvm flutter pub outdated --dependency-overrides \
		--dev-dependencies --prereleases --show-all --transitive

# Format code
format:
	@dart format --fix -l 120 .