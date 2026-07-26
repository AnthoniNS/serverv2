#!/bin/bash
set -e

PHP_VERSION="8.3"
LOG_FILE="/tmp/php_grpc_install_$(date +%Y%m%d_%H%M%S).log"

log() {
    echo "$(date '+%Y-%m-%d %H:%M:%S') - $1" | tee -a "$LOG_FILE"
}

run_cmd() {
    local cmd="$*"
    log "Executando: $cmd"
    eval "$cmd" 2>&1 | tee -a "$LOG_FILE"
}

log "Iniciando instalação: PHP ${PHP_VERSION} + gRPC via sury.org (Debian)"

# 1. Instalar dependências básicas
run_cmd "sudo apt update -y"
run_cmd "sudo apt install -y ca-certificates wget gnupg lsb-release"

# 2. Adicionar chave GPG do repositório sury.org
log "Adicionando chave GPG do sury.org"
run_cmd "wget -O /tmp/sury-php.gpg https://packages.sury.org/php/apt.gpg"
run_cmd "sudo gpg --dearmor -o /etc/apt/trusted.gpg.d/sury-php.gpg /tmp/sury-php.gpg"

# 3. Adicionar repositório
log "Adicionando repositório sury.org"
echo "deb https://packages.sury.org/php/ $(lsb_release -sc) main" | sudo tee /etc/apt/sources.list.d/php.list

# 4. Atualizar
run_cmd "sudo apt update -y"

# 5. Instalar PHP 8.3 + dependências necessárias (incluindo xml!)
run_cmd "sudo apt install -y \
    php${PHP_VERSION} \
    php${PHP_VERSION}-cli \
    php${PHP_VERSION}-dev \
    php${PHP_VERSION}-xml \
    php${PHP_VERSION}-mbstring \
    php-pear \
    build-essential \
    autoconf \
    libtool \
    pkg-config \
    zlib1g-dev"

# 6. Instalar extensão gRPC
if ! php${PHP_VERSION} -m | grep -qi grpc; then
    log "Instalando extensão gRPC"
    run_cmd "sudo pecl install grpc"
    sudo mkdir -p "/etc/php/${PHP_VERSION}/mods-available"
    echo "extension=grpc.so" | sudo tee "/etc/php/${PHP_VERSION}/mods-available/grpc.ini" > /dev/null
    run_cmd "sudo phpenmod -v ${PHP_VERSION} -s ALL grpc"
else
    log "Extensão gRPC já instalada"
fi

# 7. Verificação final
if php${PHP_VERSION} -m | grep -qi grpc; then
    log "✅ Sucesso! PHP ${PHP_VERSION} + gRPC funcionando."
else
    log "❌ Falha ao carregar gRPC."
    exit 1
fi

log "Use: php8.3 para executar scripts"
log "Log: $LOG_FILE"