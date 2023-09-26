import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('SynchronousFuture: 2 -> 1', () async {
    scheduleMicrotask(() {
      print(1);
    });
    final x = await SynchronousFuture(() {
      return 2;
    }());
    print(x);
  });

  test('Future.sync: 1 -> 2', () async {
    scheduleMicrotask(() {
      print(1);
    });
    final x = await Future.sync(() {
      return 2;
    });
    print(x);
  });
}
