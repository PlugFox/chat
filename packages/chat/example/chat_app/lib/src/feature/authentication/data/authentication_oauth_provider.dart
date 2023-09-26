import 'package:google_sign_in/google_sign_in.dart';
import 'package:l/l.dart';
import 'package:meta/meta.dart';

/// Google sign in scopes.
const List<String> _kGoogleSignInScopes = <String>[
  'email',
  'profile',
  // 'https://www.googleapis.com/auth/contacts.readonly',
];

@immutable
final class SignInAbortedException implements Exception {
  const SignInAbortedException();

  @override
  String toString() => 'Sign in aborted';
}

abstract interface class IAuthenticationOAuthProvider {
  Future<String> signInWithGoogle();
}

class AuthenticationOAuthProvider$DesktopImpl implements IAuthenticationOAuthProvider {
  AuthenticationOAuthProvider$DesktopImpl();

  @override
  Future<String> signInWithGoogle() {
    // TODO: implement signInWithGoogle
    throw UnimplementedError();
  }
}

class AuthenticationOAuthProvider$MobileImpl implements IAuthenticationOAuthProvider {
  AuthenticationOAuthProvider$MobileImpl();

  @override
  Future<String> signInWithGoogle() async {
    final googleSignIn = GoogleSignIn(
      scopes: _kGoogleSignInScopes,
      signInOption: SignInOption.standard,
    );

    l.vvvvv('Auth | Beginning interactive google sign in');

    // Trigger the authentication flow
    final googleUser = await googleSignIn.signIn();
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

class AuthenticationOAuthProvider$WebImpl implements IAuthenticationOAuthProvider {
  AuthenticationOAuthProvider$WebImpl();

  @override
  Future<String> signInWithGoogle() async {
    final googleSignIn = GoogleSignIn(
      scopes: _kGoogleSignInScopes,
      signInOption: SignInOption.standard,
    );

    l.vvvvv('Auth | Beginning interactive google sign in');

    // In the web, googleSignIn.signInSilently() triggers the One Tap UX.
    //
    // It is recommended by Google Identity Services to render both the One Tap UX
    // and the Google Sign In button together to "reduce friction and improve
    // sign-in rates" ([docs](https://developers.google.com/identity/gsi/web/guides/display-button#html)).
    final googleUser = await googleSignIn.signInSilently();
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
