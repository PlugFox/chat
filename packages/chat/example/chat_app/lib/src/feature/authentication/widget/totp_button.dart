import 'package:chatapp/src/common/controller/state_consumer.dart';
import 'package:chatapp/src/feature/authentication/controller/authentication_controller.dart';
import 'package:chatapp/src/feature/authentication/controller/authentication_state.dart';
import 'package:chatapp/src/feature/authentication/widget/authentication_scope.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// {@template totp_button}
/// TotpButton widget.
/// {@endtemplate}
class TotpButton extends StatelessWidget {
  /// {@macro totp_button}
  const TotpButton({super.key});

  /* #endregion */
  @override
  Widget build(BuildContext context) => ElevatedButton(
        /* onPressed: () => showModalBottomSheet<void>(
          context: context,
          builder: (context) => Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 24),
            child: SizedBox(
              width: 480,
              child: const _TotpDialog(),
            ),
          ),
          constraints: const BoxConstraints(maxHeight: 320, maxWidth: 640),
          showDragHandle: true,
          isDismissible: true,
          useRootNavigator: true,
        ).ignore(), */
        onPressed: () => showAdaptiveDialog<void>(
          context: context,
          builder: (context) => const Dialog(
            child: Padding(
              padding: EdgeInsets.symmetric(horizontal: 16, vertical: 24),
              child: SizedBox(
                width: 480,
                height: 320,
                child: _TotpDialog(),
              ),
            ),
          ),
        ).ignore(),
        child: const Text('Sign In with TOTP'),
      );
}

/// {@template totp_button}
/// _TotpDialog widget.
/// {@endtemplate}
class _TotpDialog extends StatefulWidget {
  /// {@macro totp_button}
  const _TotpDialog();

  @override
  State<_TotpDialog> createState() => _TotpDialogState();
}

class _TotpDialogState extends State<_TotpDialog> {
  final TextEditingController _emailController = TextEditingController();
  String? _email;
  late final AuthenticationController _authController;
  final FocusNode _emailFocusNode = FocusNode();
  String? _emailError;
  final _emailFormatters = <TextInputFormatter>[
    FilteringTextInputFormatter.allow(
      /// Allow only letters, numbers,
      /// and the following characters: @.-_+
      RegExp(r'\@|[A-Z]|[a-z]|[0-9]|\.|\-|\_|\+'),
    ),
    const _UsernameTextFormatter(),
  ];

  @override
  void initState() {
    super.initState();
    _authController = AuthenticationScope.controllerOf(context);
  }

  @override
  void dispose() {
    _emailController.dispose();
    _emailFocusNode.dispose();
    super.dispose();
  }

  void setEmail(String email) => _emailController.text = _email = email.trim().toLowerCase();

  @override
  Widget build(BuildContext context) => Center(
        child: SizedBox(
          width: 640,
          child: StateConsumer<AuthenticationState>(
            controller: _authController,
            builder: (context, state, _) => Column(
              mainAxisAlignment: MainAxisAlignment.spaceBetween,
              children: <Widget>[
                if (MediaQuery.sizeOf(context).height > 480)
                  const Text(
                    'TOTP', // Localization.of(context).totpLabel,
                    overflow: TextOverflow.ellipsis,
                    style: TextStyle(
                      fontSize: 18,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                const SizedBox(height: 24),
                SizedBox(
                  height: 92,
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.center,
                    children: <Widget>[
                      Expanded(
                        child: TextField(
                          focusNode: _emailFocusNode,
                          enabled: state.isIdling && _email == null,
                          maxLines: 1,
                          minLines: 1,
                          controller: _emailController,
                          autocorrect: false,
                          autofillHints: const <String>[AutofillHints.username, AutofillHints.email],
                          keyboardType: TextInputType.emailAddress,
                          inputFormatters: _emailFormatters,
                          decoration: InputDecoration(
                            labelText: 'Email',
                            hintText: 'Enter your email',
                            helperText: '',
                            helperMaxLines: 1,
                            errorText: _emailError ?? state.error,
                            errorMaxLines: 1,
                          ),
                        ),
                      ),
                      const SizedBox(width: 8),
                      SizedBox.square(
                        dimension: 48,
                        child: ValueListenableBuilder<TextEditingValue>(
                            valueListenable: _emailController,
                            builder: (context, value, _) {
                              final text = value.text.trim();
                              final a = text.indexOf('@');
                              return IconButton(
                                icon: const Icon(Icons.send),
                                onPressed: state.isIdling && _email == null && a > 0 && a < text.length - 1
                                    ? () => setEmail(text)
                                    : null,
                              );
                            }),
                      )
                    ],
                  ),
                ),
                const SizedBox(height: 24),
                SizedBox(
                  height: 64,
                  child: AnimatedSwitcher(
                    duration: const Duration(milliseconds: 250),
                    child: _email == null ? const SizedBox.expand() : const Placeholder(),
                  ),
                ),
                /* const SizedBox(height: 24),
                    SizedBox(
                      height: 48,
                      child: Row(
                        crossAxisAlignment: CrossAxisAlignment.stretch,
                        mainAxisAlignment: MainAxisAlignment.spaceBetween,
                        children: <Widget>[
                          Expanded(
                            child: TextButton(
                              onPressed: () => Navigator.pop(context),
                              child: Text(MaterialLocalizations.of(context).cancelButtonLabel),
                            ),
                          ),
                        ],
                      ),
                    ), */
              ],
            ),
          ),
        ),
      );
}

class _UsernameTextFormatter extends TextInputFormatter {
  const _UsernameTextFormatter();
  @override
  TextEditingValue formatEditUpdate(TextEditingValue oldValue, TextEditingValue newValue) => TextEditingValue(
        text: newValue.text.toLowerCase(),
        selection: newValue.selection,
      );
}
