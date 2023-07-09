.PHONY: clean login deploy codegen

login:
	@gcloud login

deploy:
	@gcloud beta run deploy chat-authentication-faas \
		--source=. \
		--project=chat-authentication-faas \
		--service-account=chat-authentication-cloud-run@chat-authentication-faas.iam.gserviceaccount.com \
		--port=8080 \
		--args="--target=anonymous" \
		--set-env-vars=URL="authentication.api.example.chat.plugfox.dev" \
		--concurrency=2 \
		--min-instances=0 \
		--max-instances=2 \
		--region=europe-west4 \
		--platform managed \
		--timeout=15s \
		--cpu=1 \
		--memory=128Mi \
		--no-use-http2 \
		--ingress=all \
		--allow-unauthenticated \
		--tag=chat

clean:
	@dart run build_runner clean
	@rm -rf bin/server.dart

get:
	@dart pub get

codegen: get
	@dart run build_runner build --delete-conflicting-outputs

build: codegen
	@dart compile exe bin/server.dart -o build/server

run: build
	dart run bin/server.dart --port=$(PORT) --target=$(FUNCTION_TARGET)