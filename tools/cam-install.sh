#!/usr/bin/env bash
# Установка записи с камеры как systemd-сервисов (Raspberry Pi).
#
#   sudo tools/cam-install.sh
#
# Что делает: проверяет ffmpeg/rclone и настройки, создаёт папку буфера,
# подставляет пути в deploy/systemd/*.service и включает сервисы.
# Повторный запуск безопасен: юниты перезаписываются, сервисы перезапускаются.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BASE_DIR=$(dirname "$SCRIPT_DIR")
CONF=${CAM_ENV:-$BASE_DIR/config/camera.env}
UNIT_DIR=$BASE_DIR/deploy/systemd
UNITS=(cam-recorder cam-upload)

if (( EUID != 0 )); then
    printf 'Нужен root: sudo %s\n' "$0" >&2
    exit 1
fi

if [[ ! -f $CONF ]]; then
    printf 'Нет файла настроек: %s\n' "$CONF" >&2
    printf 'Скопируйте config/camera.env.example в config/camera.env и заполните его.\n' >&2
    exit 1
fi

set -a
# shellcheck source=/dev/null
. "$CONF"
set +a

CAM_OUT_DIR=${CAM_OUT_DIR:-/mnt/usb/cam}
CAM_LOG_DIR=${CAM_LOG_DIR:-$BASE_DIR/data}
CAM_REMOTE=${CAM_REMOTE:-}

if [[ -z $CAM_REMOTE ]]; then
    printf 'В %s не задан CAM_REMOTE (например yadisk:cam)\n' "$CONF" >&2
    exit 1
fi

# Сервисы работают от обычного пользователя, не от root.
APP_USER=${CAM_APP_USER:-${SUDO_USER:-pi}}
if ! id "$APP_USER" >/dev/null 2>&1; then
    printf 'Пользователь «%s» не найден. Задайте нужного: CAM_APP_USER=pi sudo -E %s\n' "$APP_USER" "$0" >&2
    exit 1
fi

for cmd in ffmpeg rclone; do
    if command -v "$cmd" >/dev/null 2>&1; then
        continue
    fi
    printf 'Не найден %s.\n' "$cmd" >&2
    case $cmd in
        ffmpeg) printf '  sudo apt install ffmpeg\n' >&2 ;;
        rclone) printf '  curl https://rclone.org/install.sh | sudo bash\n' >&2 ;;
    esac
    exit 1
done

remote_name=${CAM_REMOTE%%:*}
if ! sudo -u "$APP_USER" rclone listremotes 2>/dev/null | grep -qxF "${remote_name}:"; then
    printf 'У пользователя «%s» нет remote «%s:» в rclone.\n' "$APP_USER" "$remote_name" >&2
    printf 'Настройте его под этим пользователем (rclone config) или поправьте CAM_REMOTE.\n' >&2
    printf 'Сейчас настроены: %s\n' "$(sudo -u "$APP_USER" rclone listremotes 2>/dev/null | tr '\n' ' ')" >&2
    exit 1
fi

mkdir -p "$CAM_OUT_DIR" "$CAM_LOG_DIR"
chown -R "$APP_USER" "$CAM_OUT_DIR" "$CAM_LOG_DIR"

for unit in "${UNITS[@]}"; do
    src=$UNIT_DIR/$unit.service
    if [[ ! -f $src ]]; then
        printf 'Нет шаблона юнита: %s\n' "$src" >&2
        exit 1
    fi
    sed -e "s|__APP_DIR__|$BASE_DIR|g" -e "s|__APP_USER__|$APP_USER|g" \
        "$src" >"/etc/systemd/system/$unit.service"
    chmod 644 "/etc/systemd/system/$unit.service"
done

systemctl daemon-reload
systemctl enable cam-recorder.service cam-upload.service >/dev/null 2>&1 || true
systemctl restart cam-recorder.service cam-upload.service

printf '\nГотово. Сервисы работают от «%s», логи в %s.\n' "$APP_USER" "$CAM_LOG_DIR"
printf 'Проверка: %s/tools/cam-status.sh\n' "$BASE_DIR"
printf 'Первый сегмент (5 минут) появится в облаке через 15-20 минут: min-age + интервал заливки.\n'
printf '\nСостояние сейчас:\n'
systemctl --no-pager --lines=3 status cam-recorder.service cam-upload.service || true
