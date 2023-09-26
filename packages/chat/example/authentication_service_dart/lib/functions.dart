import 'dart:async';

import 'package:chat_authentication/src/common/responses.dart';
import 'package:functions_framework/functions_framework.dart';
import 'package:shelf/shelf.dart' as shelf;

/// Sign In anonymous
@CloudFunction(target: 'function')
Future<shelf.Response> function(shelf.Request request) async {
  try {
    // TODO(plugfox): Router based on switch & (method, path)
    // TODO(plugfox): Add version endpoint
    return Responses.ok({'token': '0-0-0-0'});
    /* if (request.method != 'POST')
      return Responses.badRequest([
        (
          code: 'method-not-allowed',
          message: 'Only POST requests are accepted.',
        ),
      ]);
    return Responses.ok({'token': '0-0-0-0'}); */
  } on Object catch (error, stackTrace) {
    return Responses.internalServerError(error, stackTrace);
  }
}
