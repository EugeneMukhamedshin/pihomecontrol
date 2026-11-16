#!/usr/bin/env bash
# Запись с камеры Tapo C320WS в локальные сегменты (ffmpeg).
#
# Камера не умеет писать в чужое облако: в приложении Tapo есть только microSD
# и платное облако Tapo Care. Зато камера отдаёт RTSP, поэтому запись делает
# Raspberry Pi, а готовые сегменты заливает tools/cam-upload.sh через rclone.
#
#   tools/cam-recorder.sh               # работать до остановки (так зовёт systemd)
#   tools/cam-recorder.sh --once        # один сеанс записи, без перезапуска
#   tools/cam-recorder.sh --print-cmd   # показать команду ffmpeg и выйти
#
# Настройки — в config/camera.env (шаблон: config/camera.env.example).
# Зависимость: ffmpeg (sudo apt install ffmpeg).

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
CAM_STALL_SECONDS=${CAM_STALL_SECONDS:-600}
CAM_MIN_FREE_GB=${CAM_MIN_FREE_GB:-2}
CAM_AUDIO=${CAM_AUDIO:-aac}
CAM_MOVFLAGS=${CAM_MOVFLAGS-+frag_keyframe+empty_moov}
CAM_LOG_DIR=${CAM_LOG_DIR:-$BASE_DIR/data}

if [[ -z ${CAM_RTSP_URL:-} ]]; then
    printf 'В %s не задан CAM_RTSP_URL\n' "$CONF" >&2
    exit 1
fi

if ! command -v ffmpeg >/dev/null 2>&1; then
    printf 'ffmpeg не найден. Установите: sudo apt install ffmpeg\n' >&2
    exit 1
fi

# Файл, отредактированный в Windows, приезжает с CRLF и ломает все значения.
if grep -q $'\r' "$CONF" 2>/dev/null; then
    printf 'ВНИМАНИЕ: %s сохранён с переводами строк CRLF.\n' "$CONF" >&2
    printf 'Исправьте на Pi: sed -i "s/\r$//" %s\n' "$CONF" >&2
fi

LOG_FILE=$CAM_LOG_DIR/cam-recorder.log
mkdir -p "$CAM_OUT_DIR" "$CAM_LOG_DIR" 2>/dev/null

# Лог не должен расти бесконечно: перед стартом старый уезжает в .log.1.
if [[ -f $LOG_FILE ]] && (( $(stat -c %s "$LOG_FILE" 2>/dev/null || printf 0) > 5242880 )); then
    mv -f "$LOG_FILE" "$LOG_FILE.1"
fi

log() {
    local line
    line="$(date '+%F %T') $*"
    printf '%s\n' "$line"
    printf '%s\n' "$line" >>"$LOG_FILE" 2>/dev/null
}

# Пароль камеры не должен попадать в лог и в вывод --print-cmd.
RTSP_DISPLAY=$(printf '%s' "$CAM_RTSP_URL" | sed -E 's#(rtsp://[^:/@]+:)[^@]*@#\1***@#')

# Имя флага таймаута зависит от версии ffmpeg: в новых -timeout, в старых
# (Debian bullseye) -stimeout. Наличие проверяем по справке демуксера.
RTSP_TIMEOUT=()
rtsp_help=$(ffmpeg -hide_banner -h demuxer=rtsp 2>/dev/null || true)
if grep -q -- ' -timeout ' <<<"$rtsp_help"; then
    RTSP_TIMEOUT=(-timeout 10000000)
elif grep -q -- ' -stimeout ' <<<"$rtsp_help"; then
    RTSP_TIMEOUT=(-stimeout 10000000)
fi

FFMPEG_ARGS=(
    -hide_banner
    -nostdin
    -loglevel warning
    -rtsp_transport tcp
    "${RTSP_TIMEOUT[@]}"
    -i "$CAM_RTSP_URL"
    -map 0:v:0
    -c:v copy
    -f segment
    -segment_time "$CAM_SEGMENT_SECONDS"
    -reset_timestamps 1
    -strftime 1
    -segment_format mp4
)

case $CAM_AUDIO in
    none)
        FFMPEG_ARGS+=(-an)
        ;;
    copy)
        FFMPEG_ARGS+=(-map '0:a:0?' -c:a copy)
        ;;
    *)
        FFMPEG_ARGS+=(-map '0:a:0?' -c:a aac)
        ;;
esac

if [[ -n $CAM_MOVFLAGS ]]; then
    FFMPEG_ARGS+=(-segment_format_options "movflags=$CAM_MOVFLAGS")
fi

FFMPEG_ARGS+=("$CAM_OUT_DIR/%Y%m%d_%H%M%S.mp4")

if [[ ${1:-} == --print-cmd ]]; then
    printf '%q ' ffmpeg
    for arg in "${FFMPEG_ARGS[@]}"; do
        if [[ $arg == "$CAM_RTSP_URL" ]]; then
            arg=$RTSP_DISPLAY
        fi
        printf '%q ' "$arg"
    done
    printf '\n'
    exit 0
fi

free_kb() {
    df -Pk "$CAM_OUT_DIR" 2>/dev/null | awk 'NR==2 {print $4}'
}

has_space() {
    local kb
    kb=$(free_kb)
    # Не смогли измерить — не мешаем записи, пусть разбирается ffmpeg.
    [[ -z $kb ]] && return 0
    (( kb >= CAM_MIN_FREE_GB * 1024 * 1024 ))
}

# Есть ли сегмент, в который писали последние N секунд.
recent_segment() {
    local window=$1 newest mtime now
    newest=$(ls -t "$CAM_OUT_DIR"/*.mp4 2>/dev/null | head -n 1)
    [[ -n $newest ]] || return 1
    mtime=$(stat -c %Y "$newest" 2>/dev/null) || return 1
    now=$(date +%s)
    (( now - mtime <= window ))
}

FFMPEG_PID=
WATCHDOG_PID=

kill_proc() {
    local pid=${1:-}
    [[ -n $pid ]] || return 0
    kill -TERM "$pid" 2>/dev/null
    local i
    for i in 1 2 3 4 5; do
        kill -0 "$pid" 2>/dev/null || return 0
        sleep 1
    done
    kill -KILL "$pid" 2>/dev/null
}

# Сторож: ffmpeg может «зависнуть» на живой TCP-сессии и молча ничего не писать.
# Если за CAM_STALL_SECONDS не появилось свежих файлов — перезапускаем поток.
watchdog() {
    local started=$SECONDS
    while sleep 15; do
        (( SECONDS - started > CAM_STALL_SECONDS )) || continue
        if ! recent_segment "$CAM_STALL_SECONDS"; then
            log "сторож: за ${CAM_STALL_SECONDS} с нет новых данных, перезапускаю ffmpeg"
            kill_proc "$FFMPEG_PID"
            return 0
        fi
        started=$SECONDS
    done
}

stop() {
    log 'получен сигнал остановки'
    kill_proc "$WATCHDOG_PID"
    kill_proc "$FFMPEG_PID"
    log 'остановлено'
    exit 0
}
trap stop INT TERM

start_stream() {
    ffmpeg "${FFMPEG_ARGS[@]}" &
    FFMPEG_PID=$!
    watchdog &
    WATCHDOG_PID=$!

    wait "$FFMPEG_PID"
    local rc=$?

    kill_proc "$WATCHDOG_PID"
    WATCHDOG_PID=
    FFMPEG_PID=
    return "$rc"
}

log "старт записи: $RTSP_DISPLAY -> $CAM_OUT_DIR (сегмент ${CAM_SEGMENT_SECONDS} с, звук $CAM_AUDIO)"

while :; do
    if ! has_space; then
        log "на $CAM_OUT_DIR меньше ${CAM_MIN_FREE_GB} ГиБ свободно, запись на паузе"
        sleep 60
        continue
    fi

    start_stream
    rc=$?
    log "ffmpeg завершился (код $rc)"

    if [[ ${1:-} == --once ]]; then
        exit "$rc"
    fi

    log 'перезапуск через 10 с'
    sleep 10
done
