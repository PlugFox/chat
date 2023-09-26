import 'package:chatapp/src/common/constant/config.dart';
import 'package:chatapp/src/common/util/error_util.dart';
import 'package:flutter/services.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:l/l.dart';
import 'package:meta/meta.dart';

/// Google sign in scopes.
const List<String> _kGoogleSignInScopes = <String>[
  'openid',
  'email',
  'profile',
  // 'https://www.googleapis.com/auth/userinfo.email',
  // 'https://www.googleapis.com/auth/userinfo.profile',
  // 'https://www.googleapis.com/auth/contacts.readonly',
];

@immutable
final class SignInAbortedException implements Exception {
  const SignInAbortedException();

  @override
  String toString() => 'Sign in aborted';
}

abstract interface class IAuthenticationSocialProvider {
  Future<String> signInWithGoogle();
}

class AuthenticationSocialProvider$MobileImpl implements IAuthenticationSocialProvider {
  AuthenticationSocialProvider$MobileImpl();
  late final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: _kGoogleSignInScopes,
    signInOption: SignInOption.standard,
    // Web related Client ID for OAuth 2.0
    // Issue and solution with Google Sign In on Android w/o Firebase
    // https://github.com/flutter/flutter/issues/20903#issuecomment-1433172720
    clientId: Config.googleClientID,
  );

  @override
  Future<String> signInWithGoogle() async {
    l.vvvvv('Auth | Beginning interactive google sign in');

    // Trigger the authentication flow
    final GoogleSignInAccount? googleUser;
    try {
      googleUser = await _googleSignIn.signIn();
    } on PlatformException catch (error, stackTrace) {
      switch (error.code) {
        case GoogleSignIn.kSignInCanceledError:
          ErrorUtil.throwWithStackTrace(const SignInAbortedException(), stackTrace);
        default:
          rethrow;
      }
    }
    if (googleUser == null) throw const SignInAbortedException();

    l.vvvvv('Auth | Getting google authentication credentials');
    // Obtain the auth details from the request
    final googleAuth = await googleUser.authentication;

    // Create a new credential
    final GoogleSignInAuthentication(idToken: String? idToken, accessToken: String? _) = googleAuth;

    if (idToken is! String || idToken.isEmpty) throw Exception('Google sign in failed (no id token)');

    l.vvvvv('Auth | Finishing google sign in');

    return idToken;
  }
}

class AuthenticationSocialProvider$DesktopImpl implements IAuthenticationSocialProvider {
  AuthenticationSocialProvider$DesktopImpl();

  @override
  Future<String> signInWithGoogle() {
    // TODO: implement signInWithGoogle
    throw UnimplementedError();
  }
}

class AuthenticationSocialProvider$WebImpl implements IAuthenticationSocialProvider {
  AuthenticationSocialProvider$WebImpl();

  /// Read more:
  /// https://pub.dev/packages/google_sign_in_web
  late final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: _kGoogleSignInScopes,
    signInOption: SignInOption.standard,
    clientId: Config.googleClientID,
  );

  @override
  Future<String> signInWithGoogle() async {
    l.vvvvv('Auth | Beginning interactive google sign in');

    // Trigger the authentication flow
    // In the web, googleSignIn.signInSilently() triggers the One Tap UX.
    //
    // It is recommended by Google Identity Services to render both the One Tap UX
    // and the Google Sign In button together to "reduce friction and improve
    // sign-in rates" ([docs](https://developers.google.com/identity/gsi/web/guides/display-button#html)).
    GoogleSignInAccount? googleUser;
    try {
      googleUser = await _googleSignIn.signInSilently(suppressErrors: false); //await _googleSignIn.signIn();
      if (googleUser == null) {
        await _googleSignIn.signIn();
        googleUser = await _googleSignIn.signInSilently(suppressErrors: false); //await _googleSignIn.signIn();
      }
    } on PlatformException catch (error, stackTrace) {
      switch (error.code) {
        case GoogleSignIn.kSignInCanceledError:
          ErrorUtil.throwWithStackTrace(const SignInAbortedException(), stackTrace);
        default:
          rethrow;
      }
    }
    if (googleUser == null) throw const SignInAbortedException();

    l.vvvvv('Auth | Getting google authentication credentials');
    // Obtain the auth details from the request
    final googleAuth = await googleUser.authentication;

    // Create a new credential
    final GoogleSignInAuthentication(idToken: String? idToken, accessToken: String? accessToken) = googleAuth;
    l.s('Auth | Google sign in succeeded (id token: $idToken, access token: $accessToken)');
    if (idToken is! String || idToken.isEmpty) throw Exception('Google sign in failed (no id token)');

    l.vvvvv('Auth | Finishing google sign in');

    return idToken;
  }
}
