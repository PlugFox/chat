import 'package:chatapp/src/feature/authentication/widget/authentication_scope.dart';
import 'package:flutter/material.dart';

State<StatefulWidget> $createGoogleSignInButtonState() => _GoogleSignInButtonState();

final class _GoogleSignInButtonState extends State<StatefulWidget> {
  @override
  Widget build(BuildContext context) => ElevatedButton(
        onPressed: () => AuthenticationScope.controllerOf(context).signInWithGoogle(),
        child: const Text('Sign In with Google'),
      );
}
