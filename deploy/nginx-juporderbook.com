# /etc/nginx/sites-available/juporderbook.com
#
# juporderbook.com goes back to the original Jupiter v1 limit-order viewer (~/workspace/jup-orderbook,
# pm2 "jup-orderbook", port 3006) until the domain expires on 8 April 2027. SpotTerminal moved to
# spotterminal.com.
#
#   sudo cp deploy/nginx-juporderbook.com /etc/nginx/sites-available/juporderbook.com
#   sudo nginx -t && sudo systemctl reload nginx

server {
    listen 80;
    listen 443 ssl;
    server_name juporderbook.com www.juporderbook.com;

    ssl_certificate /etc/ssl/cloudflare/origin.crt;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;

    location / {
        proxy_pass http://127.0.0.1:3006;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
