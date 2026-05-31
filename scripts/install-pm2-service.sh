#!/bin/bash
# Run this inside WSL with: sudo bash /mnt/c/Users/karen/Desktop/Github\ Projects/MyBot/scripts/install-pm2-service.sh
set -e

echo "Installing wait-for-mnt-c.sh..."
cat > /usr/local/bin/wait-for-mnt-c.sh << 'EOF'
#!/bin/bash
for i in $(seq 1 30); do
    [ -d /mnt/c/Windows ] && exit 0
    sleep 2
done
echo "Timed out waiting for /mnt/c" >&2
exit 1
EOF
chmod +x /usr/local/bin/wait-for-mnt-c.sh

echo "Installing pm2-karen.service..."
cat > /etc/systemd/system/pm2-karen.service << 'EOF'
[Unit]
Description=PM2 process manager
Documentation=https://pm2.keymetrics.io/
After=network.target local-fs.target

[Service]
Type=forking
User=karen
LimitNOFILE=infinity
LimitNPROC=infinity
LimitCORE=infinity
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin:/home/karen/.nvm/versions/node/v24.14.1/bin
Environment=PM2_HOME=/home/karen/.pm2
PIDFile=/home/karen/.pm2/pm2.pid
Restart=on-failure
RestartSec=10

ExecStartPre=/usr/local/bin/wait-for-mnt-c.sh
ExecStart=/home/karen/.nvm/versions/node/v24.14.1/lib/node_modules/pm2/bin/pm2 resurrect
ExecReload=/home/karen/.nvm/versions/node/v24.14.1/lib/node_modules/pm2/bin/pm2 reload all
ExecStop=/home/karen/.nvm/versions/node/v24.14.1/lib/node_modules/pm2/bin/pm2 kill

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable pm2-karen.service

echo "Done! PM2 will now wait for /mnt/c before resurrecting services on boot."
echo "Verify with: systemctl status pm2-karen.service"
