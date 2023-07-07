import 'dart:async';

import 'package:chat_app/src/common/util/error_util.dart';
import 'package:chat_app/src/feature/dependencies/initialization/initialize_dependencies.dart';
import 'package:chat_app/src/feature/dependencies/model/dependencies.dart';
import 'package:flutter/foundation.dart' show ChangeNotifier, FlutterError, PlatformDispatcher, ValueListenable;
import 'package:flutter/services.dart' show SystemChrome, DeviceOrientation;
import 'package:flutter/widgets.dart' show WidgetsBinding, WidgetsFlutterBinding;

abstract interface class InitializationProgress implements ValueListenable<({int progress, String message})> {}

class InitializationExecutor with ChangeNotifier, InitializeDependencies implements InitializationProgress {
  InitializationExecutor();

  /// Ephemerally initializes the app and prepares it for use.
  Future<Dependencies>? _$currentInitialization;

  int _progress = 0;
  String _message = '';

  @override
  ({int progress, String message}) get value => (progress: _progress, message: _message);

  /// Initializes the app and prepares it for use.
  Future<Dependencies> call({
    List<DeviceOrientation>? orientations,
    void Function(int progress, String message)? onProgress,
    void Function(Dependencies dependencies)? onSuccess,
    void Function(Object error, StackTrace stackTrace)? onError,
  }) =>
      _$currentInitialization ??= Future<Dependencies>(() async {
        late final WidgetsBinding binding;
        final stopwatch = Stopwatch()..start();
        void pushProgress(int progress, String message) {
          onProgress?.call(
            _progress = progress.clamp(0, 100),
            _message = message,
          );
          notifyListeners();
        }

        pushProgress(0, 'Initializing');

        try {
          binding = WidgetsFlutterBinding.ensureInitialized()..deferFirstFrame();
          await _catchExceptions();
          if (orientations != null) await SystemChrome.setPreferredOrientations(orientations);
          final dependencies =
              await $initializeDependencies(onProgress: pushProgress).timeout(const Duration(minutes: 5));
          pushProgress(100, 'Done');
          onSuccess?.call(dependencies);
          return dependencies;
        } on Object catch (error, stackTrace) {
          onError?.call(error, stackTrace);
          ErrorUtil.logError(
            error,
            stackTrace,
            hint: 'Failed to initialize app',
          ).ignore();
          rethrow;
        } finally {
          stopwatch.stop();
          binding.addPostFrameCallback((_) {
            // Closes splash screen, and show the app layout.
            binding.allowFirstFrame();
            //final context = binding.renderViewElement;
          });
          _$currentInitialization = null;
        }
      });

  Future<void> _catchExceptions() async {
    try {
      PlatformDispatcher.instance.onError = (error, stackTrace) {
        ErrorUtil.logError(
          error,
          stackTrace,
          hint: 'ROOT | ${Error.safeToString(error)}',
        ).ignore();
        return true;
      };

      final sourceFlutterError = FlutterError.onError;
      FlutterError.onError = (final details) {
        ErrorUtil.logError(
          details.exception,
          details.stack ?? StackTrace.current,
          hint: 'FLUTTER ERROR\r\n$details',
        ).ignore();
        // FlutterError.presentError(details);
        sourceFlutterError?.call(details);
      };
    } on Object catch (error, stackTrace) {
      ErrorUtil.logError(error, stackTrace).ignore();
    }
  }
}
