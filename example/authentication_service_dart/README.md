# FaaS Authentication for Chat App

## Hot to build

```shell
$ dart run build_runner build --delete-conflicting-outputs
$ dart compile exe bin/server.dart -o bin/server
```

## Hot to run local

```shell
$ dart run ./bin/server.dart --port 8080 --target=anonymous --signature-type=http
```

## Hot to run local with Docker

```shell
$ docker build -t chat-authentication-faas .
$ docker run -d --rm -p 8080:8080 --name chat-authentication chat-authentication-faas
```

## Config Google Cloud Run

[Quickstart](https://github.com/GoogleCloudPlatform/functions-framework-dart/blob/main/docs/quickstarts/03-quickstart-cloudrun.md)
[Installing Google Cloud SDK](https://cloud.google.com/sdk/docs/install)

```shell
$ gcloud auth login
$ gcloud config set core/project chat-authentication-faas
$ gcloud config set run/platform managed
$ gcloud config set run/region europe-west4
```

## Hot to deploy to Google Cloud Run

[gcloud beta run deploy](https://cloud.google.com/sdk/gcloud/reference/beta/run/deploy)

```shell
$ gcloud beta run deploy chat-authentication-faas \
  --source=. \                                                        # Use $PWD or . for current directory
  --project=chat-authentication-faas \                                # The Google Cloud project ID
  --port=8080 \                                                       # Container port to receive requests at. Also sets the $PORT environment variable.
  --args="--target=function" \                                       # Arguments to pass to the container. Can be specified multiple times.
  --set-env-vars=URL="authentication.api.example.chat.plugfox.dev" \  # Set environment variables. Can be specified multiple times.
  --concurrency=2 \                                                   # Maximum number of concurrent requests allowed for this service.
  --min-instances=0 \                                                 # Minimum number of container instances to run for this service.
  --max-instances=2 \                                                 # Maximum number of container instances to run for this service.
  --region=europe-west4 \                                             # E.g.: us-central1
  --platform managed \                                                # For Cloud Run
  --timeout=15s \                                                     # Set the maximum request execution time (timeout)
  --cpu=1 \                                                           # Set a CPU limit in cpu units
  --memory=128Mi \                                                    # Set a memory limit in memory units
  --no-use-http2 \                                                    # Disable HTTP/2
  --ingress=all \                                                     # For public access
  --allow-unauthenticated \                                           # For public access
  --tag=chat                                                          # The tag to apply to the image
```
