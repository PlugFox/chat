import 'dart:io' as io;

import 'package:chatapp/src/common/util/platform/keyboard_observer_interface.dart';
import 'package:chatapp/src/common/util/platform/keyboard_observer_windows.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:meta/meta.dart';

IKeyboardObserver $getKeyboardObserver() =>
    io.Platform.isWindows ? $getKeyboardObserver$Windows() : _KeyboardObserver$IO();

@sealed
class _KeyboardObserver$IO with _IsKeyPressed$IO, ChangeNotifier implements IKeyboardObserver {
  @override
  bool get isControlPressed =>
      isKeyPressed(LogicalKeyboardKey.controlLeft) || isKeyPressed(LogicalKeyboardKey.controlRight);

  @override
  bool get isShiftPressed => isKeyPressed(LogicalKeyboardKey.shiftLeft) || isKeyPressed(LogicalKeyboardKey.shiftRight);

  @override
  bool get isAltPressed => isKeyPressed(LogicalKeyboardKey.altLeft) || isKeyPressed(LogicalKeyboardKey.altRight);

  @override
  bool get isMetaPressed => isKeyPressed(LogicalKeyboardKey.metaLeft) || isKeyPressed(LogicalKeyboardKey.metaRight);
}

mixin _IsKeyPressed$IO {
  /// Returns true if the given [KeyboardKey] is pressed.
  bool isKeyPressed(LogicalKeyboardKey key) => RawKeyboard.instance.keysPressed.contains(key);
}
