import 'package:chatapp/src/feature/authentication/data/authentication_repository.dart';
import 'package:chatapp/src/feature/dependencies/model/app_metadata.dart';

abstract interface class Dependencies {
  /// App metadata
  abstract final AppMetadata appMetadata;

  /// Authentication repository
  abstract final IAuthenticationRepository authenticationRepository;
}
