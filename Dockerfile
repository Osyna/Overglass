FROM python:3.12-slim

# wof shells out to the system ssh client (SSHTransport) and ssh-keygen (wof pair).
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssh-client \
    && apt-get clean \
    && rm -r /var/lib/apt/lists

# Editable install: the server reads web/ and the CLI reads tv-assets/ relative to the source tree.
WORKDIR /app
COPY . /app
RUN pip install --no-cache-dir -e .

# Non-root user; /config holds config.json, the dedicated key and known_hosts (mount a volume here).
RUN useradd --uid 1000 --create-home wof \
    && mkdir /config \
    && chown wof:wof /config
ENV WEBOS_FOUNDRY_HOME=/config
VOLUME /config
USER wof

EXPOSE 8765
# Binding 0.0.0.0 makes `wof serve` require a token: use `server_token` in the config or pass --token.
ENTRYPOINT ["wof"]
CMD ["serve", "--host", "0.0.0.0"]
