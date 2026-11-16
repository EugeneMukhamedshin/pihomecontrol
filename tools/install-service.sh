#!/usr/bin/env bash
# Установка pihomecontrol как systemd-сервиса (Raspberry Pi).
#
#   sudo bash tools/install-service.sh
#
# Что делает: проверяет Node.js и pigpiod, создаёт config/pihomecontrol.env
# из примера, подставляет пути в deploy/systemd/pihomecontrol.service, включает
# автозапуск и (пере)запускает сервис. Повторный запуск безопасен: юнит
# перезаписывается, настройки и данные не трогаются.

set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BASE_DIR=$(dirname "$SCRIPT_DIR")
UNIT_NAME=pihomecontrol
UNIT_SRC=$BASE_DIR/deploy/systemd/$UNIT_NAME.service
ENV_SRC=$BASE_DIR/config/pihomecontrol.env.example
ENV_DST=$BASE_DIR/config/pihomecontrol.env
DO_INSTALL=1

for arg in "$@"; do
    case $arg in
        --no-install) DO_INSTALL=0 ;;
        -h|--help)
            printf 'Использование: sudo bash %s [--no-install]\n' "$0"
            exit 0
            ;;
        *)
            printf 'Неизвестный аргумент: %s\n' "$arg" >&2
            exit 1
            ;;
    esac
done

if (( EUID != 0 )); then
    printf 'Нужен root: sudo bash %s\n' "$0" >&2
    exit 1
fi

if [[ ! -f $UNIT_SRC ]]; then
    printf 'Нет шаблона юнита: %s\n' "$UNIT_SRC" >&2
    exit 1
fi

# Сервис работает от обычного пользователя, не от root.
APP_USER=${APP_USER:-${SUDO_USER:-pi}}
if ! id "$APP_USER" >/dev/null 2>&1; then
    printf 'Пользователь «%s» не найден. Задайте нужного: APP_USER=pi sudo -E bash %s\n' "$APP_USER" "$0" >&2
    exit 1
fi

# Node ищем в окружении пользователя сервиса: так находится и nvm.
NODE_BIN=$(sudo -u "$APP_USER" bash -lc 'command -v node' 2>/dev/null | tail -n 1 || true)
if [[ -z $NODE_BIN ]]; then
    NODE_BIN=$(command -v node 2>/dev/null || true)
fi
if [[ -z $NODE_BIN || ! -x $NODE_BIN ]]; then
    printf 'Не найден node. Поставьте Node.js 20+ (например, через NodeSource) и повторите.\n' >&2
    exit 1
fi
NODE_MAJOR=$("$NODE_BIN" -p 'process.versions.node.split(".")[0]')
if (( NODE_MAJOR < 20 )); then
    printf 'Внимание: найден Node.js %s (%s), проект рассчитан на 20+.\n' "$("$NODE_BIN" -v)" "$NODE_BIN" >&2
fi

# Серво котла работает через демон pigpio.
if ! systemctl cat pigpiod.service >/dev/null 2>&1; then
    printf 'Не найден pigpiod.service — без него не запустится управление серво (GPIO22).\n' >&2
    printf 'Установите и включите:\n' >&2
    printf '  sudo apt install pigpio\n' >&2
    printf '  sudo systemctl enable --now pigpiod\n' >&2
    exit 1
fi
systemctl enable --now pigpiod.service >/dev/null 2>&1 || true
if ! systemctl is-active --quiet pigpiod.service; then
    printf 'Внимание: pigpiod не запустился, серво котла может не работать.\n' >&2
    printf 'Проверьте: sudo systemctl status pigpiod\n' >&2
fi

if ! getent group gpio >/dev/null 2>&1; then
    printf 'Нет группы gpio — сервис не получит доступ к GPIO.\n' >&2
    printf 'Проверьте установку Raspberry Pi OS (группа должна существовать).\n' >&2
    exit 1
fi

# Настройки сервиса: не перезаписываем существующий файл.
mkdir -p "$BASE_DIR/config"
if [[ ! -f $ENV_SRC ]]; then
    printf 'Нет шаблона настроек: %s\n' "$ENV_SRC" >&2
    exit 1
fi
if [[ ! -f $ENV_DST ]]; then
    cp "$ENV_SRC" "$ENV_DST"
    chown "$APP_USER" "$ENV_DST"
    chmod 600 "$ENV_DST"
    printf 'Создан %s (права 600).\n' "$ENV_DST"
fi

# config.txt больше не хранится в git: на новом клоне его нет.
if [[ ! -f $BASE_DIR/config.txt && -f $BASE_DIR/config.example.txt ]]; then
    cp "$BASE_DIR/config.example.txt" "$BASE_DIR/config.txt"
    chown "$APP_USER" "$BASE_DIR/config.txt"
    printf 'Создан config.txt из config.example.txt.\n'
fi

# Приложению нужно писать config.txt, state.json, auth.json, data/ и лог.
if ! sudo -u "$APP_USER" test -w "$BASE_DIR"; then
    printf 'Каталог %s недоступен на запись пользователю «%s».\n' "$BASE_DIR" "$APP_USER" >&2
    printf 'Исправьте владельца: sudo chown -R %s:%s %s\n' "$APP_USER" "$APP_USER" "$BASE_DIR" >&2
    exit 1
fi

# Старая версия могла работать под root (pm2 + порт 80), и её файлы остались
# root-owned. Их нужно отдать пользователю сервиса, иначе не запишутся уставки.
fix_owner() {
    local path=$1
    [[ -e $path ]] || return 0
    if ! sudo -u "$APP_USER" test -w "$path"; then
        printf 'Исправляю владельца: %s\n' "$path"
        chown -R "$APP_USER" "$path"
    fi
}
for path in "$BASE_DIR/config.txt" "$BASE_DIR/devices.json" "$BASE_DIR/state.json" \
            "$BASE_DIR/auth.json" "$BASE_DIR/data" "$BASE_DIR/node_modules"; do
    fix_owner "$path"
done
for path in "$BASE_DIR"/homecontrol.log* "$BASE_DIR"/*.tmp; do
    fix_owner "$path"
done

# Первый запуск после старой версии: зависимости должны соответствовать
# текущему package.json. npm запускаем от пользователя сервиса, не от root.
if (( DO_INSTALL )) && [[ -f $BASE_DIR/package-lock.json ]]; then
    printf 'Устанавливаю зависимости (npm ci)...\n'
    sudo -u "$APP_USER" bash -lc "cd \"$BASE_DIR\" && npm ci --omit=dev --no-audit --no-fund"
fi

"$NODE_BIN" --check "$BASE_DIR/homecontrol.js"

PORT=80
env_port=$(sed -n 's/^PORT=//p' "$ENV_DST" | tr -d '\r' | tr -d '"' | tail -n 1)
if [[ -n $env_port ]]; then
    PORT=$env_port
fi

sed -e "s|__APP_DIR__|$BASE_DIR|g" \
    -e "s|__APP_USER__|$APP_USER|g" \
    -e "s|__NODE_BIN__|$NODE_BIN|g" \
    "$UNIT_SRC" >"/etc/systemd/system/$UNIT_NAME.service"
chmod 644 "/etc/systemd/system/$UNIT_NAME.service"

systemctl daemon-reload
systemctl enable "$UNIT_NAME.service" >/dev/null 2>&1

port_is_busy() {
    if command -v ss >/dev/null 2>&1; then
        ss -ltnH "sport = :$1" 2>/dev/null | grep -q .
        return
    fi
    return 1
}

if systemctl is-active --quiet "$UNIT_NAME.service"; then
    systemctl restart "$UNIT_NAME.service"
elif port_is_busy "$PORT"; then
    # Не убиваем старую версию (обычно это pm2) без согласия.
    printf '\nПорт %s уже занят — вероятно, старая версия ещё работает под pm2.\n' "$PORT" >&2
    printf 'Остановите её и запустите сервис:\n' >&2
    printf '  pm2 list && pm2 stop <имя> && pm2 delete <имя> && pm2 save\n' >&2
    printf '  sudo systemctl start %s\n' "$UNIT_NAME.service" >&2
    printf '\nЮнит установлен и включён в автозапуск; после освобождения порта сервис можно запускать.\n' >&2
    exit 0
else
    systemctl start "$UNIT_NAME.service"
fi

sleep 2
if ! systemctl is-active --quiet "$UNIT_NAME.service"; then
    printf '\nСервис не запустился. Последние строки лога:\n' >&2
    journalctl -u "$UNIT_NAME.service" -n 40 --no-pager >&2 || true
    printf '\nЕсли приложение ещё под pm2 — остановите его и повторите:\n' >&2
    printf '  pm2 stop <имя> && pm2 delete <имя> && pm2 save\n' >&2
    printf '  sudo systemctl restart %s\n' "$UNIT_NAME.service" >&2
    exit 1
fi

if command -v curl >/dev/null 2>&1 && ! curl -fsS "http://127.0.0.1:${PORT}/login" >/dev/null 2>&1; then
    printf '\nСервис активен, но http://127.0.0.1:%s/login не отвечает.\n' "$PORT" >&2
    printf 'Проверьте, не занят ли порт другой копией приложения, и посмотрите лог:\n' >&2
    journalctl -u "$UNIT_NAME.service" -n 20 --no-pager >&2 || true
    exit 1
fi

printf '\nГотово. Сервис «%s» работает от «%s», порт %s.\n' "$UNIT_NAME.service" "$APP_USER" "$PORT"
printf 'Статус: systemctl status %s\n' "$UNIT_NAME.service"
printf 'Логи:   journalctl -u %s -f\n' "$UNIT_NAME.service"

# Показываем последнюю строку о том, откуда взят пароль. Если он создан
# только что, в строке будет сам пароль; AUTH_PASSWORD и auth.json не раскрываем.
auth_line=$(journalctl -u "$UNIT_NAME.service" -n 500 --no-pager 2>/dev/null \
    | grep 'Аутентификация включена' | tail -n 1 || true)
if [[ -n $auth_line ]]; then
    printf '\n%s\n' "$auth_line"
else
    printf '\nПароль: journalctl -u %s | grep "Аутентификация включена"\n' "$UNIT_NAME.service"
fi
