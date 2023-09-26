import 'dart:convert';

import 'package:test/test.dart';
import 'package:ws/ws.dart';

void main() {
  group('Connection', () {
    setUp(() {
      // Additional setup goes here.
    });

    test('Connection test', () async {
      final client = WebSocketClient();

      // Listen for messages from the server
      client.stream.listen((message) {
        print('Received: $message');
      });

      await client.connect('ws://127.0.0.1:8000/');

      // Send a message with the JWT token to the server
      await client.add(jsonEncode({
        'id': 1, // id must be unique for each request
        'method': 'connect',
        'params': {
          'token': _jwt,
          // Other connection parameters here
        },
      }));

      // Send an echo RPC request
      await client.add(jsonEncode({
        'id': 2, // id must be unique for each request
        'method': 'rpc',
        'params': {
          'method': 'echo',
          'params': {'message': 'Hello, Centrifugo!'}
        },
      }));

      await Future<void>.delayed(Duration(seconds: 1));

      await client.close();
    });
  });
}

const String _jwt = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.'
    'eyJzdWIiOiIxMjMiLCJleHAiOjE2ODk0MzcwMjEsImlhdCI6MTY4O'
    'TQyMjYyMSwiYXVkIjoiZGNlN2M4NDUtZDBkNy00ZTAwLWJmNDAtMD'
    'Q0NWM3Mjk5NDc4IiwiaXNzIjoiY2hhdCJ9.'
    'RyTXx39RMKcn4LybpvWag6GKqldrVD9I0cWWC1hLrIg';
