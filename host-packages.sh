#!/usr/bin/env bash
# Host distribution detection and Docker Engine installation. Sourced by install.sh.

detect_host_os() {
  [[ -f /etc/os-release ]] || { echo 'HATA: /etc/os-release bulunamadı.' >&2; return 1; }
  # shellcheck disable=SC1091
  source /etc/os-release
  case "${ID:-}:${VERSION_ID:-}" in
    ubuntu:22.04|ubuntu:24.04|ubuntu:26.04)
      PANEL_PACKAGE_MANAGER=apt
      PANEL_DOCKER_REPO=ubuntu
      ;;
    debian:12|debian:13)
      PANEL_PACKAGE_MANAGER=apt
      PANEL_DOCKER_REPO=debian
      ;;
    almalinux:9|almalinux:9.*|almalinux:10|almalinux:10.*|rocky:9|rocky:9.*|rocky:10|rocky:10.*|centos:9|centos:10)
      PANEL_PACKAGE_MANAGER=dnf
      PANEL_DOCKER_REPO=centos
      ;;
    *)
      echo "HATA: Desteklenmeyen sistem: ${PRETTY_NAME:-bilinmiyor}. Destek: Ubuntu 22.04/24.04/26.04, Debian 12/13, AlmaLinux/Rocky 9/10, CentOS Stream 9/10." >&2
      return 1
      ;;
  esac
  [[ "$(uname -m)" == x86_64 ]] || { echo 'HATA: Bu paket x86_64 VDS için hazırlandı.' >&2; return 1; }
}

install_host_tools() {
  if [[ $PANEL_PACKAGE_MANAGER == apt ]]; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq ca-certificates curl git openssl iproute2
  else
    dnf install -y ca-certificates curl git openssl iproute dnf-plugins-core
  fi
}

install_host_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    return 0
  fi
  if command -v docker >/dev/null 2>&1; then
    echo 'HATA: Mevcut Docker kurulumunda Compose eklentisi yok. Önce Docker Engine ve Compose kurulumunu düzeltin.' >&2
    return 1
  fi
  if [[ $PANEL_PACKAGE_MANAGER == apt ]]; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$PANEL_DOCKER_REPO/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    printf 'deb [arch=%s signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s %s stable\n' \
      "$(dpkg --print-architecture)" "$PANEL_DOCKER_REPO" "$VERSION_CODENAME" > /etc/apt/sources.list.d/docker.list
    apt-get update -qq
    apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
    dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
}
