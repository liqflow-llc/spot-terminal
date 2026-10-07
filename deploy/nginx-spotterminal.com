# /etc/nginx/sites-available/spotterminal.com
#
# Install (first time, before a certificate exists, use the HTTP-only block and run certbot):
#   sudo cp deploy/nginx-spotterminal.com /etc/nginx/sites-available/spotterminal.com
#   sudo ln -sf /etc/nginx/sites-available/spotterminal.com /etc/nginx/sites-enabled/spotterminal.com
#   sudo nginx -t && sudo systemctl reload nginx
#
# Let's Encrypt certificate (certbot --nginx, http-01 through Cloudflare's proxy, auto-renewed),
# so Cloudflare SSL mode "Full (strict)" works. The shared Cloudflare origin certificate doesn't
# cover spotterminal.com.

# HTTP -> HTTPS (Cloudflare reaches the origin over HTTPS for HTTPS requests, so no loop).
server {
    listen 80;
    server_name spotterminal.com www.spotterminal.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl;
    server_name spotterminal.com www.spotterminal.com;

    ssl_certificate /etc/letsencrypt/live/spotterminal.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/spotterminal.com/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
