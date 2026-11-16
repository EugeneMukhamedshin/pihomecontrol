#!/usr/bin/env bash
# Диагностика записи с камеры: процессы, локальный буфер, облако, хвост логов.
#
#   tools/cam-status.sh
#
# Код возврата: 0 — всё на месте, 1 — запись или заливка не работают
# (удобно дёргать из мониторинга и cron).

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
CAM_SEGMENT_SECONDS=${CAM_SEGMENT_SECONDS:-300}
CAM_LOG_DIR=${CAM_LOG_DIR:-$BASE_DIR/data}

problems=0
FAIL='НЕ РАБОТАЕТ'
warn() {
    problems=$((problems + 1))
    printf '  ! %s\n' "$*"
}

human_bytes() {
    local bytes=${1:-0}
    if command -v numfmt >/dev/null 2>&1; then
        numfmt --to=iec --suffix=B "$bytes"
    else
        printf '%s B' "$bytes"
    fi
}

human_age() {
    local seconds=${1:-0}
    if (( seconds < 90 )); then
        printf '%s с' "$seconds"
    elif (( seconds < 5400 )); then
        printf '%s мин' "$(( seconds / 60 ))"
    else
        printf '%s ч %s мин' "$(( seconds / 3600 ))" "$(( (seconds % 3600) / 60 ))"
    fi
}

unit_state() {
    local unit=$1 pattern=$2 pid
    if systemctl is-active --quiet "$unit" 2>/dev/null; then
        pid=$(systemctl show -p MainPID --value "$unit" 2>/dev/null)
        printf 'работает (systemd, pid %s)' "${pid:-?}"
        return 0
    fi
    if pid=$(pgrep -f "$pattern" 2>/dev/null | head -n 1); then
        printf 'работает (pid %s)' "$pid"
        return 0
    fi
    printf '%s' "$FAIL"
    return 1
}

newest_file() {
    ls -t "$CAM_OUT_DIR"/*.mp4 2>/dev/null | head -n 1
}

file_age() {
    local file=$1 mtime
    [[ -n $file ]] || return 1
    mtime=$(stat -c %Y "$file" 2>/dev/null) || return 1
    printf '%s' "$(( $(date +%s) - mtime ))"
}

printf '== Камера ==\n'
printf '  RTSP:      %s\n' "$(printf '%s' "${CAM_RTSP_URL:-}" | sed -E 's#(rtsp://[^:/@]+:)[^@]*@#\1***@#')"
printf '  Буфер:     %s\n' "$CAM_OUT_DIR"
printf '  Облако:    %s\n' "${CAM_REMOTE:-не задан}"

printf '\n== Процессы ==\n'
if state=$(unit_state cam-recorder cam-recorder.sh); then
    printf '  Рекордер:  %s\n' "$state"
else
    printf '  Рекордер:  %s\n' "$state"
    warn 'запись не идёт: рекордер не запущен'
fi
if state=$(unit_state cam-upload cam-upload.sh); then
    printf '  Заливка:   %s\n' "$state"
else
    printf '  Заливка:   %s\n' "$state"
    warn 'заливка не идёт: cam-upload не запущен'
fi

printf '\n== Локальный буфер ==\n'
if [[ -d $CAM_OUT_DIR ]]; then
    files=$(find "$CAM_OUT_DIR" -maxdepth 1 -type f -name '*.mp4' 2>/dev/null | wc -l)
    size=$(find "$CAM_OUT_DIR" -maxdepth 1 -type f -name '*.mp4' -printf '%s\n' 2>/dev/null \
        | awk '{s += $1} END {print s + 0}')
    printf '  Файлов:    %s (%s)\n' "$files" "$(human_bytes "$size")"

    latest=$(newest_file)
    if [[ -n $latest ]]; then
        age=$(file_age "$latest") || age=0
        printf '  Последний: %s, %s назад\n' "$(basename "$latest")" "$(human_age "$age")"

        # Два сегмента + запас: если свежее этого нет, поток встал.
        limit=$(( CAM_SEGMENT_SECONDS * 2 + 300 ))
        if (( age > limit )); then
            warn "нет новых сегментов уже $(human_age "$age") — камера или ffmpeg молчат"
        fi
    else
        printf '  Последний: нет файлов\n'
        warn 'в буфере нет ни одного сегмента'
    fi

    if command -v df >/dev/null 2>&1; then
        printf '  Свободно:  %s\n' "$(df -Ph "$CAM_OUT_DIR" 2>/dev/null | awk 'NR==2 {print $4 " из " $2}')"
    fi
else
    printf '  папки %s нет\n' "$CAM_OUT_DIR"
    warn "папка буфера $CAM_OUT_DIR не существует"
fi

printf '\n== Облако ==\n'
if command -v rclone >/dev/null 2>&1; then
    if summary=$(rclone size "$CAM_REMOTE" 2>/dev/null); then
        printf '%s\n' "$summary" | sed 's/^/  /'
        printf '  Свежие файлы:\n'
        rclone lsl "$CAM_REMOTE" --max-depth 1 2>/dev/null | sort -k2,3 | tail -n 3 | sed 's/^/    /'
    else
        printf '  не удалось получить список: проверьте rclone lsd %s и сеть\n' "$CAM_REMOTE"
        warn "rclone не отвечает для $CAM_REMOTE"
    fi
else
    printf '  rclone не установлен\n'
    warn 'rclone не найден'
fi

printf '\n== Логи (%s) ==\n' "$CAM_LOG_DIR"
for name in cam-recorder.log cam-upload.log; do
    file=$CAM_LOG_DIR/$name
    if [[ -f $file ]]; then
        printf '  %s:\n' "$name"
        tail -n 3 "$file" 2>/dev/null | sed 's/^/    /'
    fi
done

printf '\n'
if (( problems == 0 )); then
    printf 'Итог: всё работает.\n'
    exit 0
fi
printf 'Итог: проблем — %s. Начните с логов выше и раздела «Камера» в README.\n' "$problems"
exit 1
