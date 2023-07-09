FROM dart:stable AS build

# Resolve app dependencies.
WORKDIR /app
COPY pubspec.* ./
RUN dart pub get

# Copy app source code and AOT compile it.
COPY . .
# Ensure packages are still up-to-date if anything has changed
RUN dart pub get --offline
RUN dart run build_runner build --delete-conflicting-outputs
RUN dart compile exe bin/server.dart -o bin/server

# Build minimal serving image from AOT-compiled `/server` and required system
# libraries and configuration files stored in `/runtime/` from the build stage.
FROM scratch
COPY --from=build /runtime/ /
COPY --from=build /app/bin/server /app/bin/

# Add lables
LABEL name="PlugFox/chat-authentication-faas" \
    description="FaaS Authentication for Chat App" \
    license="MIT" \
    vcs-type="git" \
    vcs-url="https://github.com/PlugFox/chat" \
    github="https://github.com/PlugFox/chat" \
    maintainer="Plague Fox <plugfox@gmail.com>" \
    authors="@PlugFox" \
    family="plugfox/chat"

# Start server.
EXPOSE 8080
CMD ["/app/bin/server", "--signature-type=http", "--port=8080", "--target=anonymous"]