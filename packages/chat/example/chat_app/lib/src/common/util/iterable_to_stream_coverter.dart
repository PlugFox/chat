import 'dart:async';
import 'dart:convert';

/// Converts an [Iterable] to a [Stream].
class IterableToStreamConverter<T> extends Converter<Iterable<T>, Stream<T>> {
  const IterableToStreamConverter();

  @override
  Stream<T> convert(final Iterable<T> input) async* {
    final stopwatch = Stopwatch()..start();
    final iterator = input.iterator;
    while (iterator.moveNext()) {
      if (stopwatch.elapsedMilliseconds > 8) {
        await Future<void>.delayed(Duration.zero);
        stopwatch.reset();
      }
      yield iterator.current;
    }
    stopwatch.stop();
  }
}

/// Extension on [Iterable] providing a `convert` to [Stream] method.
extension IterableToStreamConverterX<T extends Object?> on Iterable<T> {
  /// Converts this [Iterable] to a [Stream].
  Stream<T> convert() => IterableToStreamConverter<T>().convert(this);
}
