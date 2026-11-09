# The official Windows x64 build of Zotero under Wine, for run.sh in this folder.
# amd64 because Zotero ships no Windows-on-ARM build and Wine runs x86 code only
# on x86; on an Apple Silicon Mac Docker emulates it.
FROM --platform=linux/amd64 debian:trixie-slim

ARG ZOTERO_VERSION=10.0.8
ENV DEBIAN_FRONTEND=noninteractive

RUN dpkg --add-architecture i386 \
	&& apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates curl gnupg unzip xvfb xauth \
	&& mkdir -pm755 /etc/apt/keyrings \
	&& curl -fsSL https://dl.winehq.org/wine-builds/winehq.key | gpg --dearmor -o /etc/apt/keyrings/winehq-archive.key \
	&& curl -fsSL https://dl.winehq.org/wine-builds/debian/dists/trixie/winehq-trixie.sources -o /etc/apt/sources.list.d/winehq-trixie.sources \
	&& apt-get update \
	&& apt-get install -y --install-recommends winehq-staging \
	&& rm -rf /var/lib/apt/lists/*

RUN curl -fsSL "https://download.zotero.org/client/release/${ZOTERO_VERSION}/Zotero-${ZOTERO_VERSION}_win-x64.zip" -o /tmp/zotero.zip \
	&& mkdir -p /opt/zotero-win \
	&& unzip -q /tmp/zotero.zip -d /opt/zotero-win \
	&& rm /tmp/zotero.zip

# A prefix built at image time keeps the first-run wineboot (minutes under
# emulation) out of every test run.
ENV WINEPREFIX=/wine WINEARCH=win64 WINEDEBUG=-all XDG_RUNTIME_DIR=/tmp/xdg
RUN mkdir -m700 /tmp/xdg && wineboot --init && wineserver --wait

# Gecko's launcher process starts the real one with ntdll patched for its DLL
# blocklist, and under Wine that child dies at once. The launcher records the
# failed start in the registry and runs in-process from then on, so one launch
# that fails here leaves the prefix in that state for every test run.
RUN mkdir -p /tmp/warm && (MOZ_HEADLESS=1 timeout 300 wine /opt/zotero-win/Zotero_win-x64/zotero.exe -profile 'Z:\tmp\warm' -no-remote || true) \
	&& wineserver --wait && rm -rf /tmp/warm \
	&& grep -q 'zotero.exe|Launcher' /wine/user.reg

COPY entry.sh /entry.sh
ENTRYPOINT ["bash", "/entry.sh"]
