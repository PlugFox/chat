import 'dart:async';

import 'package:chatapp/src/common/constant/config.dart';
import 'package:chatapp/src/feature/authentication/widget/authentication_scope.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';

State<StatefulWidget> $createGoogleSignInButtonState() => _GoogleSignInButtonState();

class _GoogleSignInButtonState extends State<StatefulWidget> {
  /// Read more:
  /// https://pub.dev/packages/google_sign_in_web
  final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: Config.googleSignInScopes,
    signInOption: SignInOption.standard,
    clientId: Config.googleSignInClientID,
  );
  StreamSubscription<GoogleSignInAccount?>? _sub;

  @override
  void initState() {
    super.initState();
    if (!kIsWeb) return;
    _sub = _googleSignIn.onCurrentUserChanged.listen(
      _onCurrentUserChanged,
      cancelOnError: false,
    );
  }

  Future<void> _onCurrentUserChanged(GoogleSignInAccount? account) async {
    if (!kIsWeb) return;
    if (account == null) return;
    if (!mounted) return;
    final controller = AuthenticationScope.controllerOf(context);

    /* final isAuthorized = await _googleSignIn.canAccessScopes(Config.googleSignInScopes);
    if (!isAuthorized) return; */

    // Obtain the auth details from the request
    final googleAuth = await account.authentication;

    // Create a new credential
    final GoogleSignInAuthentication(idToken: String? idToken, accessToken: String? _) = googleAuth;

    if (idToken is! String || idToken.isEmpty) return;
    controller.signInWithGoogle(googleIdJWT: idToken);
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!kIsWeb) return const SizedBox.shrink();
    return (GoogleSignInPlatform.instance as dynamic).renderButton() as Widget;
  }
}
