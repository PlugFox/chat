import 'dart:async';
import 'dart:convert';

import 'package:shelf/shelf.dart' as shelf;

const ({String ok, String error}) _kStatus = (ok: 'ok', error: 'error');

const _headers = <String, String>{
  'Content-Type': 'application/json; charset=utf-8',
  /* 'Cache-Control': 'public, max-age=86400', */
};

sealed class Responses {
  /// Response encoder
  static final Converter<Map<String, Object?>, List<int>> _encoder =
      JsonEncoder().cast<Map<String, Object?>, String>().fuse(Utf8Encoder());

  static FutureOr<shelf.Response> ok(Map<String, Object> data) {
    final bytes = _encoder.convert(
      <String, Object>{
        'status': _kStatus.ok,
        'data': data,
      },
    );
    return shelf.Response.ok(
      bytes,
      headers: <String, String>{
        ..._headers,
        'Content-Length': bytes.length.toString(),
      },
    );
  }

  static FutureOr<shelf.Response> badRequest(
      Iterable<({String code, String message})> reasons) {
    final bytes = _encoder.convert(
      <String, Object>{
        'status': _kStatus.error,
        'errors': reasons
            .map<Map<String, String>>(
              (reason) => <String, String>{
                'code': reason.code,
                'message': reason.message,
              },
            )
            .toList(),
      },
    );
    return shelf.Response.badRequest(
      body: bytes,
      headers: <String, String>{
        ..._headers,
        'Content-Length': bytes.length.toString(),
      },
    );
  }

  static FutureOr<shelf.Response> internalServerError([
    Object? error,
    // ignore: unused_element
    StackTrace? stackTrace,
  ]) {
    final bytes = _encoder.convert(
      <String, Object>{
        'status': _kStatus.error,
        'errors': <Map<String, String>>[
          <String, String>{
            'code': 'internal',
            'message': error?.toString() ?? 'Internal Server Error',
          },
        ],
      },
    );
    return shelf.Response.internalServerError(
      body: bytes,
      headers: <String, String>{
        ..._headers,
        'Content-Length': bytes.length.toString(),
      },
    );
  }
}
