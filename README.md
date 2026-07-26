Como usar:
Salve o script como serve/install.sh

Torne executável: chmod +x install.sh

Execute com: sudo ./install.sh


####Caddy nao identificando a pasta

✅ Solução definitiva (mantendo tudo em /root/...)

##Execute estes comandos em sequência:

sudo chmod 755 /root
sudo chmod 755 /root/serve-node
sudo chmod 755 /root/serve-node/serve
sudo chmod 755 /root/serve-node/serve/caddy
sudo chmod -R 755 /root/serve-node/serve/caddy/sites-enabled
sudo chown -R caddy:caddy /root/serve-node/serve/caddy


#Isso não dá acesso de leitura total ao /root, apenas permite que o Caddy “atravesse” as pastas até chegar à sites-enabled.

#Depois disso, recarregue novamente o Caddy:

sudo systemctl reload caddy


E verifique:

sudo journalctl -u caddy -f


✅ Se estiver rodando como serviço (systemd) (mais comum no Ubuntu)
sudo systemctl restart caddy


Ver status:

sudo systemctl status caddy

