import 'dart:async';

import 'package:chat_authentication/src/common/responses.dart';
import 'package:functions_framework/functions_framework.dart';
import 'package:shelf/shelf.dart' as shelf;

/// Sign In anonymous
@CloudFunction(target: 'anonymous')
Future<shelf.Response> anonymous(shelf.Request request) async {
  try {
    if (request.method != 'POST')
      return Responses.badRequest([
        (
          code: 'method-not-allowed',
          message: 'Only POST requests are accepted.',
        ),
      ]);
    return Responses.ok({'token': '0-0-0-0'});
  } on Object catch (error, stackTrace) {
    return Responses.internalServerError(error, stackTrace);
  }
}
