import 'package:chatapp/src/feature/authentication/widget/authentication_scope.dart';
import 'package:chatapp/src/feature/authentication/widget/totp_button.dart';
import 'package:flutter/material.dart';

/// {@template sign_in_screen}
/// SignInScreen widget.
/// {@endtemplate}
class SignInScreen extends StatelessWidget {
  /// {@macro sign_in_screen}
  const SignInScreen({super.key});

  @override
  Widget build(BuildContext context) => Navigator(
        pages: <Page<Object?>>[
          MaterialPage<void>(
            child: Scaffold(
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
                    const TotpButton(),

                    /* const SizedBox(height: 16),
                const GoogleSignInButton(), */
                  ],
                ),
              ),
            ),
          ),
        ],
        onPopPage: (route, result) => route.didPop(result),
      );
}
