import 'package:chatapp/src/feature/authentication/widget/platform/google_sign_in_button_vm.dart'
    if (dart.library.js_util) 'package:chatapp/src/feature/authentication/widget/platform/google_sign_in_button_js.dart';
import 'package:flutter/material.dart';

/// {@template google_sign_in_button}
/// GoogleSignInButton widget.
/// {@endtemplate}
class GoogleSignInButton extends StatefulWidget {
  /// {@macro google_sign_in_button}
  const GoogleSignInButton({super.key});

  @override
  // ignore: no_logic_in_create_state
  State<StatefulWidget> createState() => $createGoogleSignInButtonState();
}
