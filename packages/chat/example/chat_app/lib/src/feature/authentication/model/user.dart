import 'package:meta/meta.dart';

/// User id type.
typedef UserId = String;

/// User token type.
typedef UserToken = String;

/// {@template user}
/// The user entry model.
/// {@endtemplate}
sealed class User with _UserPatternMatching, _UserShortcuts {
  /// {@macro user}
  const User._();

  /// {@macro user}
  @literal
  const factory User.unauthenticated() = UnauthenticatedUser;

  /// {@macro user}
  const factory User.authenticated({
    required UserId id,
    required String username,
    required UserToken token,
  }) = AuthenticatedUser;

  /// Creates a [User] from a json representation.
  ///
  /// {@macro user}
  factory User.fromJson(Map<String, Object> json) => switch (json) {
        {'id': UserId _, 'token': UserToken _} => AuthenticatedUser.fromJson(json),
        _ => const UnauthenticatedUser(),
      };

  /// The user's id.
  abstract final UserId? id;

  /// The user's username/handle.
  abstract final String? username;

  /// The user's token.
  abstract final UserToken? token;

  /// Converts this user to a json representation.
  Map<String, Object?> toJson();
}

/// Unauthenticated user.
///
/// {@macro user}
class UnauthenticatedUser extends User {
  /// Unauthenticated user.
  ///
  /// {@macro user}
  const UnauthenticatedUser() : super._();

  /// Creates a [UnauthenticatedUser] from a json representation.
  ///
  /// {@macro user}
  factory UnauthenticatedUser.fromJson(Map<String, Object> json) => const UnauthenticatedUser();

  @override
  UserId? get id => null;

  @override
  String? get username => null;

  @override
  UserToken? get token => null;

  @override
  @nonVirtual
  bool get isAuthenticated => false;

  @override
  T map<T>({
    required T Function(UnauthenticatedUser user) unauthenticated,
    required T Function(AuthenticatedUser user) authenticated,
  }) =>
      unauthenticated(this);

  @override
  Map<String, Object?> toJson() => <String, Object?>{};

  @override
  int get hashCode => -2;

  @override
  bool operator ==(Object other) => identical(this, other) || other is UnauthenticatedUser && id == other.id;

  @override
  String toString() => 'UnauthenticatedUser()';
}

/// Authenticated user.
///
/// {@macro user}
final class AuthenticatedUser extends User {
  /// Authenticated user.
  ///
  /// {@macro user}
  const AuthenticatedUser({
    required this.id,
    required this.username,
    required this.token,
  }) : super._();

  /// Creates a [AuthenticatedUser] from a json representation.
  ///
  /// {@macro user}
  factory AuthenticatedUser.fromJson(Map<String, Object> json) {
    if (json.isEmpty) throw FormatException('Json is empty', json);
    if (json
        case <String, Object?>{
          'id': UserId id,
          'username': String username,
          'token': UserToken token,
        })
      return AuthenticatedUser(
        id: id,
        username: username,
        token: token,
      );
    throw FormatException('Invalid json format', json);
  }

  @override
  @nonVirtual
  final UserId id;

  @override
  final String username;

  @override
  @nonVirtual
  final UserToken token;

  @override
  @nonVirtual
  bool get isAuthenticated => true;

  @override
  T map<T>({
    required T Function(UnauthenticatedUser user) unauthenticated,
    required T Function(AuthenticatedUser user) authenticated,
  }) =>
      authenticated(this);

  @override
  Map<String, Object?> toJson() => <String, Object?>{
        'id': id,
        'username': username,
        'token': token,
      };

  @override
  int get hashCode => id.hashCode;

  @override
  bool operator ==(Object other) =>
      identical(this, other) ||
      other is AuthenticatedUser && id == other.id && username == other.username && token == other.token;

  @override
  String toString() => 'AuthenticatedUser(id: $id, username: $username)';
}

mixin _UserPatternMatching {
  /// Pattern matching on [User] subclasses.
  T map<T>({
    required T Function(UnauthenticatedUser user) unauthenticated,
    required T Function(AuthenticatedUser user) authenticated,
  });

  /// Pattern matching on [User] subclasses.
  T maybeMap<T>({
    required T Function() orElse,
    T Function(UnauthenticatedUser user)? unauthenticated,
    T Function(AuthenticatedUser user)? authenticated,
  }) =>
      map<T>(
        unauthenticated: (user) => unauthenticated?.call(user) ?? orElse(),
        authenticated: (user) => authenticated?.call(user) ?? orElse(),
      );

  /// Pattern matching on [User] subclasses.
  T? mapOrNull<T>({
    T Function(UnauthenticatedUser user)? unauthenticated,
    T Function(AuthenticatedUser user)? authenticated,
  }) =>
      map<T?>(
        unauthenticated: (user) => unauthenticated?.call(user),
        authenticated: (user) => authenticated?.call(user),
      );
}

mixin _UserShortcuts on _UserPatternMatching {
  /// User is authenticated.
  bool get isAuthenticated;

  /// User is not authenticated.
  bool get isNotAuthenticated => !isAuthenticated;
}
