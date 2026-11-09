# Linux runtime for the Zotero integration run (target "zotero") and for
# npm run shots (target "shots"). Built and run by run.sh and shots.sh here.
FROM debian:bookworm-slim AS base
# Zotero's tarball bundles Gecko but links against the system GTK/X stack;
# the fonts stand in for the macOS system fonts the CSS falls back to.
RUN apt-get update && apt-get install -y --no-install-recommends \
		ca-certificates libgtk-3-0 libdbus-glib-1-2 libxt6 libx11-xcb1 libasound2 libpci3 \
		fonts-dejavu-core fonts-liberation2 nodejs \
	&& rm -rf /var/lib/apt/lists/*
RUN useradd --create-home --uid 1000 zusia

FROM base AS shots
RUN apt-get update && apt-get install -y --no-install-recommends firefox-esr python3-pil \
	&& rm -rf /var/lib/apt/lists/* \
	&& ln -s /usr/bin/firefox-esr /usr/local/bin/firefox
USER zusia

FROM debian:bookworm-slim AS fetch
ARG ZOTERO_VERSION=10.0.8
ARG TARGETARCH
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
	&& rm -rf /var/lib/apt/lists/*
RUN set -eu; \
	case "$TARGETARCH" in \
		arm64) platform=linux-arm64 ;; \
		amd64) platform=linux-x86_64 ;; \
		*) echo "Zotero publishes no Linux build for $TARGETARCH" >&2; exit 1 ;; \
	esac; \
	mkdir /opt/zotero; \
	curl -fsSL "https://download.zotero.org/client/release/$ZOTERO_VERSION/Zotero-${ZOTERO_VERSION}_$platform.tar.xz" \
		| tar -xJ -C /opt/zotero --strip-components=1; \
	test -x /opt/zotero/zotero

FROM base AS zotero
COPY --from=fetch /opt/zotero /opt/zotero
COPY cli-stub /usr/local/bin/agy
RUN ln -s agy /usr/local/bin/claude && ln -s agy /usr/local/bin/codex
ENV ZOTERO_BIN=/opt/zotero/zotero
USER zusia
