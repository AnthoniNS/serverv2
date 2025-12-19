#!/bin/bash
set -e

PHP_VERSION="8.3"
LOG_FILE="/tmp/fullstack_install_$(date +%Y%m%d_%H%M%S).log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

run_cmd() {
    local cmd="$*"
    log "Executando: $cmd"
    eval "$cmd" 2>&1 | tee -a "$LOG_FILE"
}

# =============================
# Detectar usuário real
# =============================
REAL_USER="${SUDO_USER:-$USER}"
if [ -z "$REAL_USER" ] || [ "$REAL_USER" = "root" ]; then
    REAL_USER=$(logname 2>/dev/null || echo "$USER")
fi

# =============================
# Detectar distribuição
# =============================
if [ -f /etc/os-release ]; then
    . /etc/os-release
    DISTRO="${ID}"
    CODENAME="${VERSION_CODENAME}"
else
    echo "❌ Falha ao detectar sistema." >&2
    exit 1
fi

if [[ "$DISTRO" != "ubuntu" && "$DISTRO" != "debian" ]]; then
    echo "❌ Apenas Ubuntu e Debian são suportados. Detectado: $DISTRO" >&2
    exit 1
fi

log "✅ Sistema: $DISTRO ($CODENAME)"
log "👤 Usuário: $REAL_USER"

# =============================
# Atualizar e instalar base
# =============================
run_cmd "sudo apt update -y"
run_cmd "sudo apt install -y ca-certificates curl wget gnupg lsb-release apt-transport-https software-properties-common unzip git build-essential"

# =============================
# Docker
# =============================
DOCKER_REPO="https://download.docker.com/linux/$DISTRO"

if ! command -v docker &> /dev/null; then
    log "📦 Instalando Docker..."

    sudo apt-get remove -y docker docker-engine docker.io containerd runc 2>/dev/null || true
    sudo mkdir -p /etc/apt/keyrings

    if [ ! -f /etc/apt/keyrings/docker.gpg ]; then
        curl -fsSL "$DOCKER_REPO/gpg" | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    fi

    if [ ! -f /etc/apt/sources.list.d/docker.list ]; then
        echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] $DOCKER_REPO $CODENAME stable" | \
            sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
        run_cmd "sudo apt update -y"
    fi

    run_cmd "sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin"

    if ! getent group docker >/dev/null 2>&1; then
        sudo groupadd docker
    fi
    if ! groups "$REAL_USER" | grep -qw docker; then
        sudo usermod -aG docker "$REAL_USER"
        log "💡 Execute 'newgrp docker' para aplicar permissões sem logout."
    fi
else
    log "🐳 Docker: $(docker --version)"
    if ! docker compose version &> /dev/null; then
        run_cmd "sudo apt install -y docker-compose-plugin"
    else
        log "🧩 Docker Compose: $(docker compose version)"
    fi
fi

# =============================
# Caddy
# =============================
if ! command -v caddy &> /dev/null; then
    log "🚀 Instalando Caddy..."
    sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list > /dev/null
    run_cmd "sudo apt update -y"
    run_cmd "sudo apt install -y caddy"
else
    log "🚀 Caddy: $(caddy version)"
fi

# =============================
# Configurar Caddyfile com admin + import
# =============================
CURRENT_DIR="$(pwd)"
CADDYFILE="/etc/caddy/Caddyfile"

log "🛠️ Configurando Caddyfile com admin API e import de sites..."

# Verificar se a pasta sites-enabled existe (não cria, só alerta)
if [ ! -d "$CURRENT_DIR/caddy/sites-enabled" ]; then
    log "⚠️ Aviso: diretório '$CURRENT_DIR/caddy/sites-enabled' não encontrado. O import pode falhar."
fi

# Montar novo Caddyfile
cat > /tmp/caddyfile_new <<EOF
{
    admin 127.0.0.1:2019
}

# Importar configurações personalizadas
import $CURRENT_DIR/caddy/sites-enabled/*
EOF

# Aplicar somente se houver mudança
if [ -f "$CADDYFILE" ]; then
    if cmp -s "/tmp/caddyfile_new" "$CADDYFILE"; then
        log "✅ Caddyfile já está atualizado. Nenhuma alteração necessária."
    else
        log "📝 Atualizando Caddyfile..."
        sudo mv /tmp/caddyfile_new "$CADDYFILE"
        log "🔄 Recarregando Caddy..."
        sudo systemctl reload caddy 2>/dev/null || sudo systemctl restart caddy
    fi
else
    log "📝 Criando Caddyfile..."
    sudo mv /tmp/caddyfile_new "$CADDYFILE"
    log "🔄 Reiniciando Caddy..."
    sudo systemctl restart caddy
fi

# =============================
# Node.js 20+
# =============================
NODE_MAJOR=0
if command -v node &> /dev/null; then
    NODE_VER=$(node -v 2>/dev/null | sed 's/v//')
    NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
    log "⬢ Node.js: v$NODE_VER"
fi

if [ "$NODE_MAJOR" -lt 20 ]; then
    log "⬢ Instalando Node.js 20.x..."
    sudo apt remove -y nodejs npm 2>/dev/null || true
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - >/dev/null
    run_cmd "sudo apt install -y nodejs"
    run_cmd "sudo npm install -g npm@latest"
else
    log "⬢ Node.js 20+ já instalado."
fi

# =============================
# PM2
# =============================
if ! command -v pm2 &> /dev/null; then
    log "⚙️ Instalando PM2..."
    run_cmd "sudo npm install -g pm2"
else
    log "⚙️ PM2: $(pm2 -v 2>/dev/null || echo 'n/a')"
fi

# =============================
# PHP
# =============================
log "🐘 Instalando PHP $PHP_VERSION..."

if [[ "$DISTRO" == "ubuntu" ]]; then
    log "Ubuntu: usando PPA ondrej/php"
    run_cmd "sudo add-apt-repository ppa:ondrej/php -y"
    run_cmd "sudo apt update -y"
elif [[ "$DISTRO" == "debian" ]]; then
    log "Debian: usando packages.sury.org/php"
    if [ ! -f /etc/apt/trusted.gpg.d/sury-php.gpg ]; then
        wget -O /tmp/sury-php.gpg https://packages.sury.org/php/apt.gpg
        sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/sury-php.gpg /tmp/sury-php.gpg
    fi
    if [ ! -f /etc/apt/sources.list.d/php.list ]; then
        echo "deb https://packages.sury.org/php/ $CODENAME main" | sudo tee /etc/apt/sources.list.d/php.list > /dev/null
        run_cmd "sudo apt update -y"
    fi
fi

if ! command -v "php${PHP_VERSION}" &> /dev/null; then
    run_cmd "sudo apt install -y \
        php${PHP_VERSION} \
        php${PHP_VERSION}-cli \
        php${PHP_VERSION}-common \
        php${PHP_VERSION}-dev \
        php${PHP_VERSION}-xml \
        php${PHP_VERSION}-mbstring \
        php${PHP_VERSION}-curl \
        php${PHP_VERSION}-zip \
        php${PHP_VERSION}-mysql \
        php${PHP_VERSION}-fpm \
        php${PHP_VERSION}-bcmath \
        php${PHP_VERSION}-gd \
        php-pear \
        unzip git build-essential autoconf libtool pkg-config \
        zlib1g-dev libzstd-dev"
else
    log "🐘 PHP $PHP_VERSION já instalado."
fi

# =============================
# gRPC
# =============================
if ! php${PHP_VERSION} -m | grep -qi grpc; then
    log "🔌 Instalando gRPC..."
    run_cmd "sudo pecl install grpc"
    sudo mkdir -p "/etc/php/${PHP_VERSION}/mods-available"
    echo "extension=grpc.so" | sudo tee "/etc/php/${PHP_VERSION}/mods-available/grpc.ini" >/dev/null
    run_cmd "sudo phpenmod -v ${PHP_VERSION} -s ALL grpc"
else
    log "🔌 gRPC já carregado."
fi

# =============================
# Composer
# =============================
if ! command -v composer &> /dev/null; then
    log "📦 Instalando Composer..."
    curl -sS https://getcomposer.org/installer -o /tmp/composer-setup.php
    run_cmd "COMPOSER_ALLOW_SUPERUSER=1 sudo php${PHP_VERSION} /tmp/composer-setup.php --install-dir=/usr/local/bin --filename=composer"
else
    log "📦 Composer: $(composer --version 2>/dev/null || echo 'n/a')"
fi

# =============================
# NPM INSTALL + PM2 START (com verificação de duplicidade)
# =============================
if [ -f "package.json" ]; then
    log "📦 Executando 'npm install' no diretório atual..."
    run_cmd "npm install"
else
    log "⚠️ Arquivo package.json não encontrado. Pulando 'npm install'."
fi

if [ -f "server.js" ]; then
    log "🔍 Verificando se o app 'SERVIDOR' já está rodando no PM2..."
    if pm2 list 2>/dev/null | grep -q "SERVIDOR"; then
        log "✅ App 'SERVIDOR' já está ativo. Nenhuma ação necessária."
    else
        log "🚀 Iniciando server.js com PM2 (nome: SERVIDOR)..."
        run_cmd "pm2 start server.js --name SERVIDOR"
        run_cmd "pm2 save"
        log "✅ Aplicação 'SERVIDOR' iniciada com sucesso!"
    fi
else
    log "⚠️ Arquivo server.js não encontrado. Não foi possível iniciar com PM2."
fi

# =============================
# Verificação final
# =============================
if php${PHP_VERSION} -m | grep -qi grpc; then
    log "✅ ✅ ✅ AMBIENTE PRONTO! ✅ ✅ ✅"
else
    log "❌ gRPC não está ativo."
    exit 1
fi

#==============================
CURRENT_DIR="$(pwd)"

sudo chmod 755 "$CURRENT_DIR/serve"
sudo chmod 755 "$CURRENT_DIR/serve/caddy"
sudo chmod -R 755 "$CURRENT_DIR/serve/caddy/sites-enabled"
sudo chown -R caddy:caddy "$CURRENT_DIR/serve/caddy"

#==============================
# =============================
# Resumo
# =============================
{
    echo ""
    echo "=================================="
    echo "✅ INSTALAÇÃO CONCLUÍDA"
    echo "=================================="
    echo "Sistema: $DISTRO ($CODENAME)"
    echo "Usuário: $REAL_USER"
    echo "Diretório do projeto: $CURRENT_DIR"
    echo "PHP: $(php${PHP_VERSION} -v 2>/dev/null | head -n1 || echo 'falhou')"
    echo "Docker: $(docker --version 2>/dev/null || echo 'n/a')"
    echo "Node: $(node -v 2>/dev/null || echo 'n/a')"
    echo "npm: $(npm -v 2>/dev/null || echo 'n/a')"
    echo "PM2: $(pm2 -v 2>/dev/null || echo 'n/a')"
    echo "Composer: $(composer --version 2>/dev/null || echo 'n/a')"
    echo "Caddy: $(caddy version 2>/dev/null || echo 'n/a')"
    if pm2 list 2>/dev/null | grep -q "SERVIDOR"; then
        echo "App: SERVIDOR (ativo no PM2)"
    else
        echo "App: SERVIDOR (não iniciado)"
    fi
    echo "Log: $LOG_FILE"
    echo "=================================="
} | tee -a "$LOG_FILE"

log "🚀 Tudo pronto! Seu Caddy está configurado para carregar sites de: $CURRENT_DIR/caddy/sites-enabled/"