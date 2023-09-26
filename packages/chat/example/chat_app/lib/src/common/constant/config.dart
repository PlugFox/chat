/// Config for app.
abstract final class Config {
  // --- API --- //

  /// Environment flavor.
  /// e.g. development, staging, production
  static final EnvironmentFlavor environment =
      EnvironmentFlavor.from(const String.fromEnvironment('ENVIRONMENT', defaultValue: 'development'));

  /// Base url for api.
  /// e.g. https://domain.tld
  static const String apiBaseUrl = String.fromEnvironment('API_BASE_URL', defaultValue: 'https://domain.tld');

  /// Timeout in milliseconds for opening url.
  /// [Dio] will throw the [DioException] with [DioExceptionType.connectTimeout] type when time out.
  /// e.g. 15000
  static const Duration apiConnectTimeout =
      Duration(milliseconds: int.fromEnvironment('API_CONNECT_TIMEOUT', defaultValue: 15000));

  /// Timeout in milliseconds for receiving data from url.
  /// [Dio] will throw the [DioException] with [DioExceptionType.receiveTimeout] type when time out.
  /// e.g. 10000
  static const Duration apiReceiveTimeout =
      Duration(milliseconds: int.fromEnvironment('API_RECEIVE_TIMEOUT', defaultValue: 10000));

  // --- Database --- //

  /// Whether to drop database on start.
  /// e.g. true
  static const bool dropDatabase = bool.fromEnvironment('DROP_DATABASE', defaultValue: false);

  /// Database file name by default.
  /// e.g. sqlite means "db.sqlite" for native platforms and "db" for web platform.
  static const String databaseName = String.fromEnvironment('DATABASE_NAME', defaultValue: 'db');

  // --- Authentication --- //

  /// Minimum length of password.
  /// e.g. 8
  static const int passwordMinLength = int.fromEnvironment('PASSWORD_MIN_LENGTH', defaultValue: 8);

  /// Maximum length of password.
  /// e.g. 32
  static const int passwordMaxLength = int.fromEnvironment('PASSWORD_MAX_LENGTH', defaultValue: 32);

  /// TOTP interval in seconds.
  static const Duration resendTotpInterval =
      Duration(seconds: int.fromEnvironment('RESEND_TOTP_INTERVAL', defaultValue: /* 1 min */ 60));

  // --- Layout --- //

  /// Maximum screen layout width for screen with list view.
  static const int maxScreenLayoutWidth = int.fromEnvironment('MAX_LAYOUT_WIDTH', defaultValue: 768);
}

/// Environment flavor.
/// e.g. development, staging, production
enum EnvironmentFlavor {
  /// Development
  development('development'),

  /// Staging
  staging('staging'),

  /// Production
  production('production');

  /// {@nodoc}
  const EnvironmentFlavor(this.value);

  /// {@nodoc}
  factory EnvironmentFlavor.from(String? value) => switch (value?.trim().toLowerCase()) {
        'development' || 'debug' || 'develop' || 'dev' => development,
        'staging' || 'profile' || 'stage' || 'stg' => staging,
        'production' || 'release' || 'prod' || 'prd' => production,
        _ => const bool.fromEnvironment('dart.vm.product') ? production : development,
      };

  /// development, staging, production
  final String value;

  /// Whether the environment is development.
  bool get isDevelopment => this == development;

  /// Whether the environment is staging.
  bool get isStaging => this == staging;

  /// Whether the environment is production.
  bool get isProduction => this == production;
}
