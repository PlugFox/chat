import 'dart:async';

import 'package:chatapp/src/feature/authentication/data/authentication_social_provider.dart';
import 'package:chatapp/src/feature/authentication/model/user.dart';

abstract interface class IAuthenticationRepository {
  Stream<User> userChanges();
  FutureOr<User> getUser();
  Future<AuthenticatedUser> signInAnonymously();

  /// Sign in with Google and return the Google User ID JWT
  /// null means the sign in is aborted.
  Future<String?> signInWithGoogle();

  Future<void> signOut();

  /* Future<void> sendSignInWithEmailLink(String email);
  Future<void> signInWithEmailLink(String email, String emailLink);
  Future<void> signInWithEmailAndPassword(String email, String password);
  Future<void> signInWithFacebook();
  Future<void> signInWithApple();
  Future<void> signInWithTwitter();
  Future<void> signInWithGithub();
  Future<void> signInWithPhoneNumber(String phoneNumber);
  Future<void> sendPasswordResetEmail(String email);
  Future<void> confirmPasswordReset(String code, String newPassword);
  Future<void> signUpWithEmailAndPassword(String email, String password);
  Future<void> deleteUser();
  Future<bool> isSignedIn(); */
}

class AuthenticationRepositoryImpl implements IAuthenticationRepository {
  AuthenticationRepositoryImpl({
    required IAuthenticationSocialProvider oauthProvider,
  }) : _oauthProvider = oauthProvider;

  final IAuthenticationSocialProvider _oauthProvider;

  final StreamController<User> _userController = StreamController<User>.broadcast();
  User _user = const User.unauthenticated();

  @override
  FutureOr<User> getUser() => _user;

  @override
  Stream<User> userChanges() => () async* {
        yield _user;
        yield* _userController.stream;
      }()
          .distinct()
          .skip(1);

  @override
  Future<AuthenticatedUser> signInAnonymously() {
    // TODO: implement signInAnonymously
    throw UnimplementedError();
  }

  @override
  Future<String?> signInWithGoogle() => _oauthProvider.signInWithGoogle();

  @override
  Future<void> signOut() => Future<void>.sync(
        () => _userController.add(
          _user = const User.unauthenticated(),
        ),
      );
}

class AuthenticationRepositoryFake implements IAuthenticationRepository {
  AuthenticationRepositoryFake();

  final StreamController<User> _userController = StreamController<User>.broadcast();
  User _user = const User.unauthenticated();

  @override
  FutureOr<User> getUser() => _user;

  @override
  Stream<User> userChanges() => () async* {
        yield _user;
        yield* _userController.stream;
      }()
          .distinct()
          .skip(1);

  @override
  Future<AuthenticatedUser> signInAnonymously() async {
    const user = AuthenticatedUser(id: 'anonymous-user-id', token: 'anonymous-user-token');
    _userController.add(_user = user);
    return user;
  }

  @override
  Future<String?> signInWithGoogle() => Future<String?>.value('google-user-id');

  @override
  Future<void> signOut() => Future<void>.sync(
        () => _userController.add(
          _user = const User.unauthenticated(),
        ),
      );
}
