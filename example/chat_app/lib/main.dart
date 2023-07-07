import 'dart:async';

import 'package:chat_app/src/common/util/logger_util.dart';
import 'package:chat_app/src/common/widget/app.dart';
import 'package:chat_app/src/feature/dependencies/initialization/initialization.dart';
import 'package:chat_app/src/feature/dependencies/widget/dependencies_scope.dart';
import 'package:chat_app/src/feature/dependencies/widget/initialization_splash_screen.dart';
import 'package:flutter/widgets.dart';
import 'package:l/l.dart';

void main() => l.capture<void>(
      () => runZonedGuarded<void>(
        () {
          final initialization = InitializationExecutor();
          runApp(
            DependenciesScope(
              initialization: initialization(),
              splashScreen: InitializationSplashScreen(
                progress: initialization,
              ),
              child: const App(),
            ),
          );
        },
        l.e,
      ),
      const LogOptions(
        handlePrint: true,
        messageFormatting: LoggerUtil.messageFormatting,
        outputInRelease: false,
        printColors: true,
      ),
    );
