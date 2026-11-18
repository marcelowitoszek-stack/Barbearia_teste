#!/bin/sh
# Primeira execucao: se a pasta de dados montada nao tiver catalogo, copia o padrao.
mkdir -p /app/dados
if [ ! -f /app/dados/catalogo.json ]; then
  cp /app/dados-padrao/catalogo.json /app/dados/catalogo.json
fi
exec "$@"
