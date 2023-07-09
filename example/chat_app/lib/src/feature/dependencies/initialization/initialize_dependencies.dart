import 'dart:async';

import 'package:chatapp/src/feature/authentication/data/authentication_repository.dart';
import 'package:chatapp/src/feature/dependencies/initialization/platform/initialization_vm.dart'
    // ignore: uri_does_not_exist
    if (dart.library.html) 'package:chatapp/src/feature/dependencies/initialization/platform/initialization_js.dart';
import 'package:chatapp/src/feature/dependencies/model/dependencies.dart';
import 'package:l/l.dart';
import 'package:meta/meta.dart';

typedef _InitializationStep = FutureOr<void> Function(_MutableDependencies dependencies);

class _MutableDependencies implements Dependencies {
  @override
  late IAuthenticationRepository authenticationRepository;
}

@internal
mixin InitializeDependencies {
  /// Initializes the app and returns a [Dependencies] object
  @protected
  Future<Dependencies> $initializeDependencies({
    void Function(int progress, String message)? onProgress,
  }) async {
    final steps = _initializationSteps;
    final dependencies = _MutableDependencies();
    final totalSteps = steps.length;
    for (var currentStep = 0; currentStep < totalSteps; currentStep++) {
      final step = steps[currentStep];
      final percent = (currentStep * 100 ~/ totalSteps).clamp(0, 100);
      onProgress?.call(percent, step.$1);
      l.v6('Initialization | $currentStep/$totalSteps ($percent%) | "${step.$1}"');
      await step.$2(dependencies);
    }
    return dependencies;
  }

  List<(String, _InitializationStep)> get _initializationSteps => <(String, _InitializationStep)>[
        (
          'Platform pre-initialization',
          (_) => $platformInitialization(),
        ),
        (
          'Authentication repository',
          (dependencies) => dependencies..authenticationRepository = AuthenticationRepositoryFake(),
        ),
        ('Fake delay 2', (_) => Future<void>.delayed(const Duration(seconds: 1))),
        ('Fake delay 3', (_) => Future<void>.delayed(const Duration(seconds: 1))),
      ];
}
