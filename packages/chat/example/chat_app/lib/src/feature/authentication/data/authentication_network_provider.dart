import 'dart:convert';

import 'package:chatapp/src/common/constant/config.dart';
import 'package:chatapp/src/feature/authentication/model/user.dart';
import 'package:http/http.dart' as http;

abstract interface class IAuthenticationNetworkProvider {
  /// Generate TOTP for the given email and send it to the mail address.
  Future<void> generateTotp(String email);

  /// Validate the given TOTP for the given email.
  Future<AuthenticatedUser> signInTotp(String email, String totp);
}

class AuthenticationNetworkProviderHttpImpl implements IAuthenticationNetworkProvider {
  AuthenticationNetworkProviderHttpImpl({
    required http.Client client,
  }) : _client = client;

  final http.Client _client;

  @override
  Future<void> generateTotp(String email) =>
      _client.get(Uri.parse('${Config.apiBaseUrl}/authenticate/totp/send?email=$email'));

  @override
  Future<AuthenticatedUser> signInTotp(String email, String totp) async {
    final response =
        await _client.get(Uri.parse('${Config.apiBaseUrl}/authenticate/totp/validate?email=$email&code=$totp'));
    if (response.statusCode != 200) throw Exception('Invalid TOTP');
    final json = const JsonDecoder().cast<Object?, Map<String, Object?>>().convert(response.body);
    if (json
        case <String, Object?>{
          'status': 'ok',
          'data': {
            'token': String token,
            'subject': String _,
            'project': String _,
            'issuer': String _,
            'issued': String _,
            'expires': String _,
            'user': <String, Object?>{
              'id': UserId id,
              'username': String username,
              'is_bot': bool _,
              'language': String _,
              'created_at': String _,
              'updated_at': String _,
              'deleted_at': null,
            }
          }
        }) {
      return AuthenticatedUser(
        id: id,
        username: username,
        token: token,
      );
    } else {
      throw Exception('Invalid TOTP');
    }
  }
}
