#!/usr/bin/env bash
# Заливка готовых сегментов с камеры в Яндекс Диск (rclone move).
#
# Работает в паре с tools/cam-recorder.sh: рекордер пишет сегменты на диск,
# этот скрипт забирает всё, что старше CAM_MIN_AGE, отправляет в облако и
# удаляет локально. Так буфер не растёт и SD-карта не забивается.
#
#   tools/cam-upload.sh          # цикл «заливка — пауза» (так зовёт systemd)
#   tools/cam-upload.sh --once   # один проход и выход
#
# Настройки — в config/camera.env.
# Зависимости: rclone и настроенный remote:
#   rclone config        # type: webdav, url: https://webdav.yandex.ru
#   rclone lsd yadisk:   # проверка, что логин принят

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BASE_DIR=$(dirname "$SCRIPT_DIR")
CONF=${CAM_ENV:-$BASE_DIR/config/camera.env}

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
CAM_MIN_AGE=${CAM_MIN_AGE:-10m}
CAM_UPLOAD_INTERVAL=${CAM_UPLOAD_INTERVAL:-120}
CAM_RETENTION_DAYS=${CAM_RETENTION_DAYS:-0}
CAM_LOG_DIR=${CAM_LOG_DIR:-$BASE_DIR/data}

if [[ -z ${CAM_REMOTE:-} ]]; then
    printf 'В %s не задан CAM_REMOTE (например yadisk:cam)\n' "$CONF" >&2
    exit 1
fi

if ! command -v rclone >/dev/null 2>&1; then
    printf 'rclone не найден. Установите: curl https://rclone.org/install.sh | sudo bash\n' >&2
    exit 1
fi

LOG_FILE=$CAM_LOG_DIR/cam-upload.log
RCLONE_LOG=$CAM_LOG_DIR/cam-rclone.log
mkdir -p "$CAM_LOG_DIR" "$CAM_OUT_DIR" 2>/dev/null

if [[ -f $LOG_FILE ]] && (( $(stat -c %s "$LOG_FILE" 2>/dev/null || printf 0) > 5242880 )); then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
fi

log() {
    local line
    line="$(date '+%F %T') $*"
    printf '%s\n' "$line"
    printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null
}

# Без настроенного remote rclone будет падать на каждом проходе — лучше сразу.
remote_name=${CAM_REMOTE%%:*}
if ! rclone listremotes 2>/dev/null | grep -qxF "${remote_name}:"; then
    printf 'В rclone нет remote «%s:». Настройте его (rclone config) или поправьте CAM_REMOTE в %s\n' \
        "$remote_name" "$CONF" >&2
    printf 'Сейчас настроены:\n' >&2
    rclone listremotes 2>/dev/null | sed 's/^/  /' >&2
    exit 1
fi

pending_count() {
    find "$CAM_OUT_DIR" -maxdepth 1 -type f -name '*.mp4' 2>/dev/null | wc -l
}

pass() {
    rclone move "$CAM_OUT_DIR" "$CAM_REMOTE" \
        --min-age "$CAM_MIN_AGE" \
        --transfers 2 \
        --checkers 4 \
        --retries 3 \
        --low-level-retries 5 \
        --contimeout 30s \
        --timeout 5m \
        --delete-empty-src-dirs \
        --log-level INFO \
        --log-file "$RCLONE_LOG"
    local rc=$?

    if (( rc == 0 )); then
        log "заливка: rclone ok"
    else
        log "заливка: rclone вернул $rc, подробности в $RCLONE_LOG"
    fi

    local pending
    pending=$(pending_count)
    if (( pending > 0 )); then
        log "в буфере $pending файл(ов): свежие ждут min-age ${CAM_MIN_AGE}"
    fi
    if (( pending > 50 )); then
        log "ВНИМАНИЕ: буфер растёт ($pending файлов) — облако не успевает или rclone падает"
    fi

    return "$rc"
}

retention() {
    (( CAM_RETENTION_DAYS > 0 )) || return 0

    # Ретеншн на корне диска вычистил бы чужие файлы — так не делаем.
    if [[ $CAM_REMOTE == *: ]]; then
        log 'ретеншн пропущен: CAM_REMOTE указывает на корень remote'
        return 0
    fi

    if rclone delete "$CAM_REMOTE" --min-age "${CAM_RETENTION_DAYS}d" --rmdirs \
        --log-level INFO --log-file "$RCLONE_LOG"; then
        log "ретеншн: удалено всё старше ${CAM_RETENTION_DAYS} дн."
    else
        log "ретеншн: rclone delete вернул ошибку, подробности в $RCLONE_LOG"
    fi
}

trap 'log "остановлено"; exit 0' INT TERM

log "старт заливки: $CAM_OUT_DIR -> $CAM_REMOTE (min-age $CAM_MIN_AGE, ретеншн ${CAM_RETENTION_DAYS} дн.)"

if [[ ${1:-} == --once ]]; then
    pass
    retention
    exit 0
fi

while :; do
    pass
    retention
    sleep "$CAM_UPLOAD_INTERVAL"
done
