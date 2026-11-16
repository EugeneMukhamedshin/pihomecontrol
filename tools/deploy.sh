#!/usr/bin/env bash
# Обновление pihomecontrol на Raspberry Pi: git pull + npm ci + перезапуск.
#
#   bash tools/deploy.sh                 # обычный деплой
#   bash tools/deploy.sh --no-pull       # код уже скопирован вручную
#   bash tools/deploy.sh --no-install    # зависимости не менялись
#
# Запускать от пользователя приложения (не от root): npm создаст root-owned
# файлы, и сервис не сможет писать config.txt/state.json. Для перезапуска
# сервиса sudo спросит пароль.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BASE_DIR=$(dirname "$SCRIPT_DIR")
SERVICE=pihomecontrol
ENV_FILE=$BASE_DIR/config/pihomecontrol.env
DO_PULL=1
DO_INSTALL=1

usage() {
    printf 'Использование: %s [--no-pull] [--no-install]\n' "$0"
}

for arg in "$@"; do
    case $arg in
        --no-pull) DO_PULL=0 ;;
        --no-install) DO_INSTALL=0 ;;
        -h|--help) usage; exit 0 ;;
        *)
            printf 'Неизвестный аргумент: %s\n' "$arg" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if (( EUID == 0 )); then
    printf 'Запускайте от пользователя приложения, а не от root: sudo нужен только для перезапуска сервиса.\n' >&2
    exit 1
fi

cd "$BASE_DIR"

PORT=80
if [[ -f $ENV_FILE ]]; then
    env_port=$(sed -n 's/^PORT=//p' "$ENV_FILE" | tr -d '\r' | tr -d '"' | tail -n 1)
    if [[ -n $env_port ]]; then
        PORT=$env_port
    fi
fi

CONFIG_BACKUP=""
restore_config() {
    if [[ -n $CONFIG_BACKUP && -f $CONFIG_BACKUP ]]; then
        mv -f "$CONFIG_BACKUP" "$BASE_DIR/config.txt"
        CONFIG_BACKUP=""
    fi
    return 0
}
trap restore_config EXIT

if (( DO_PULL )); then
    if [[ ! -d $BASE_DIR/.git ]]; then
        printf 'Это не git-копия (%s/.git не найден). Используйте --no-pull.\n' "$BASE_DIR" >&2
        exit 1
    fi

    # config.txt — runtime-файл: приложение меняет его во время работы.
    # Убираем его с пути git pull (и, если он ещё отслеживается, откатываем
    # локальную правку), чтобы обновление не удалило уставки. После pull
    # возвращаем файл на место.
    if [[ -f $BASE_DIR/config.txt ]]; then
        CONFIG_BACKUP=$(mktemp)
        cp "$BASE_DIR/config.txt" "$CONFIG_BACKUP"
        if git ls-files --error-unmatch config.txt >/dev/null 2>&1; then
            git checkout -- config.txt
        else
            rm -f "$BASE_DIR/config.txt"
        fi
    fi

    # devices.json тоже правят на Pi, для него достаточно --autostash.
    if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
        printf 'Есть локальные изменения — делаю git pull --autostash.\n'
        git pull --ff-only --autostash
    else
        git pull --ff-only
    fi
    restore_config()
    printf 'Версия: %s\n' "$(git log -1 --oneline)"
fi

if (( DO_INSTALL )); then
    printf 'Устанавливаю зависимости (npm ci)...\n'
    npm ci --omit=dev --no-audit --no-fund
fi

node --check homecontrol.js
for file in lib/*.js; do
    node --check "$file"
done

if ! systemctl cat "$SERVICE.service" >/dev/null 2>&1; then
    printf 'Сервис %s не установлен. Сначала: sudo bash tools/install-service.sh\n' "$SERVICE" >&2
    exit 1
fi

printf 'Перезапускаю %s...\n' "$SERVICE"
sudo systemctl restart "$SERVICE.service"

wait_http() {
    local attempt
    for attempt in $(seq 1 15); do
        if curl -fsS "http://127.0.0.1:${PORT}/login" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done
    return 1
}

sleep 1
if ! systemctl is-active --quiet "$SERVICE.service"; then
    printf '\nСервис не запустился. Последние строки лога:\n' >&2
    journalctl -u "$SERVICE.service" -n 40 --no-pager >&2 || true
    exit 1
fi

if command -v curl >/dev/null 2>&1; then
    if ! wait_http; then
        printf '\nСервис активен, но http://127.0.0.1:%s/login не отвечает.\n' "$PORT" >&2
        journalctl -u "$SERVICE.service" -n 40 --no-pager >&2 || true
        exit 1
    fi
    printf 'Проверка: http://127.0.0.1:%s/login отвечает.\n' "$PORT"
else
    printf 'curl не найден — проверьте вручную: systemctl status %s\n' "$SERVICE" >&2
fi

printf '\nГотово. Логи: journalctl -u %s -f\n' "$SERVICE"
printf 'Пароль при первом запуске: journalctl -u %s | grep "Пароль создан"\n' "$SERVICE"
