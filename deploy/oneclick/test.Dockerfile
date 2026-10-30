FROM ubuntu:22.04
ENV DEBIAN_FRONTEND=noninteractive
ARG UBUNTU_MIRROR=http://archive.ubuntu.com/ubuntu
RUN sed -i "s|http://archive.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g; s|http://security.ubuntu.com/ubuntu|${UBUNTU_MIRROR}|g" /etc/apt/sources.list && apt-get -o Acquire::Retries=3 update && apt-get install -y --no-install-recommends systemd systemd-sysv python3 apache2-bin apache2-utils openssl ca-certificates curl media-types iproute2 && rm -rf /var/lib/apt/lists/*
RUN systemctl mask systemd-binfmt.service
ENV container=docker
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
