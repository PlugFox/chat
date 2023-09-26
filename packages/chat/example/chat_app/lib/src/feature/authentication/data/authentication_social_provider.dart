import 'package:chatapp/src/common/constant/config.dart';
import 'package:flutter/services.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:l/l.dart';

abstract interface class IAuthenticationSocialProvider {
  /// Sign in with Google and return the ID token.
  /// null if the sign in is aborted.
  Future<String?> signInWithGoogle();
}

class AuthenticationSocialProvider$MobileImpl implements IAuthenticationSocialProvider {
  AuthenticationSocialProvider$MobileImpl();
  late final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: Config.googleSignInScopes,
    signInOption: SignInOption.standard,
    // Web related Client ID for OAuth 2.0
    // Issue and solution with Google Sign In on Android w/o Firebase
    // https://github.com/flutter/flutter/issues/20903#issuecomment-1433172720
    clientId: Config.googleSignInClientID,
  );

  @override
  Future<String?> signInWithGoogle() async {
    l.vvvvv('Auth | Beginning interactive google sign in');

    // Trigger the authentication flow
    final GoogleSignInAccount? googleUser;
    try {
      googleUser = await _googleSignIn.signIn();
    } on PlatformException catch (error) {
      switch (error.code) {
        case GoogleSignIn.kSignInCanceledError:
          return null;
        default:
          rethrow;
      }
    }
    if (googleUser == null) return null;

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
  Future<String?> signInWithGoogle() {
    // TODO: implement signInWithGoogle
    throw UnimplementedError();
  }
}

class AuthenticationSocialProvider$WebImpl implements IAuthenticationSocialProvider {
  AuthenticationSocialProvider$WebImpl();

  /// Read more:
  /// https://pub.dev/packages/google_sign_in_web
  late final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: Config.googleSignInScopes,
    signInOption: SignInOption.standard,
    clientId: Config.googleSignInClientID,
  );

  @override
  Future<String?> signInWithGoogle() async {
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
    } on PlatformException catch (error) {
      switch (error.code) {
        case GoogleSignIn.kSignInCanceledError:
          return null;
        default:
          rethrow;
      }
    }
    if (googleUser == null) return null;

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
