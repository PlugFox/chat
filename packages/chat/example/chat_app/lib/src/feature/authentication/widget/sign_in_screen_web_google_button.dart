import 'dart:async';

import 'package:chatapp/src/common/constant/config.dart';
import 'package:chatapp/src/feature/authentication/widget/authentication_scope.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:google_sign_in/google_sign_in.dart';
import 'package:google_sign_in_platform_interface/google_sign_in_platform_interface.dart';
import 'package:google_sign_in_web/google_sign_in_web.dart' as web;
import 'package:l/l.dart';

/// {@template sign_in_screen}
/// SignInScreen widget.
/// {@endtemplate}
class SignInScreen extends StatefulWidget {
  /// {@macro sign_in_screen}
  const SignInScreen({super.key});

  @override
  State<SignInScreen> createState() => _SignInScreenState();
}

class _SignInScreenState extends State<SignInScreen> {
  GoogleSignInAccount? _currentUser;
  bool _isAuthorized = false; // has granted permissions?
  final String _contactText = '';

  /// Read more:
  /// https://pub.dev/packages/google_sign_in_web
  late final GoogleSignIn _googleSignIn = GoogleSignIn(
    scopes: <String>[
      'openid',
      'email',
      'profile',
      // 'https://www.googleapis.com/auth/userinfo.email',
      // 'https://www.googleapis.com/auth/userinfo.profile',
      // 'https://www.googleapis.com/auth/contacts.readonly',
    ],
    signInOption: SignInOption.standard,
    clientId: Config.googleClientID,
  );
  StreamSubscription<GoogleSignInAccount?>? _sub;

  @override
  void initState() {
    super.initState();
    _sub = _googleSignIn.onCurrentUserChanged.listen((account) async {
      // In mobile, being authenticated means being authorized...
      bool isAuthorized = account != null;
      // However, in the web...
      if (kIsWeb && account != null) {
        isAuthorized = await _googleSignIn.canAccessScopes(<String>[
          'openid',
          'email',
          'profile',
        ]);
      }

      // Obtain the auth details from the request
      final googleAuth = await account?.authentication;

      if (googleAuth != null) {
        // Create a new credential
        final GoogleSignInAuthentication(idToken: String? idToken, accessToken: String? _) = googleAuth;
        l.s('Auth | Google ID Token: $idToken');
      }

      if (mounted)
        setState(() {
          _currentUser = account;
          _isAuthorized = isAuthorized;
        });
    });

    // In the web, _googleSignIn.signInSilently() triggers the One Tap UX.
    //
    // It is recommended by Google Identity Services to render both the One Tap UX
    // and the Google Sign In button together to "reduce friction and improve
    // sign-in rates" ([docs](https://developers.google.com/identity/gsi/web/guides/display-button#html)).
    _googleSignIn.signInSilently();
  }

  @override
  void dispose() {
    _sub?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
        appBar: AppBar(
          title: const Text('Sign In'),
        ),
        body: Align(
          alignment: const Alignment(0, -.2),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              ElevatedButton(
                onPressed: () => AuthenticationScope.controllerOf(context).signInAnonymously(),
                child: const Text('Sign In Anonymously'),
              ),
              const SizedBox(height: 16),
              ElevatedButton(
                onPressed: () => AuthenticationScope.controllerOf(context).signInWithGoogle(),
                child: const Text('Sign In with Google'),
              ),
              if (kIsWeb) (GoogleSignInPlatform.instance as web.GoogleSignInPlugin).renderButton(),
            ],
          ),
        ),
      );
}
