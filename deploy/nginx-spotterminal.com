# /etc/nginx/sites-available/spotterminal.com
#
# Install:
#   sudo cp deploy/nginx-spotterminal.com /etc/nginx/sites-available/spotterminal.com
#   sudo ln -sf /etc/nginx/sites-available/spotterminal.com /etc/nginx/sites-enabled/spotterminal.com
#   sudo nginx -t && sudo systemctl reload nginx
#   sudo certbot --nginx -d spotterminal.com -d www.spotterminal.com
#
# Starts as HTTP only; certbot adds the 443 server with a Let's Encrypt certificate (http-01
# through Cloudflare's proxy, like w2w.chat), which satisfies Cloudflare SSL mode "Full (strict)".
# The shared Cloudflare origin certificate doesn't cover spotterminal.com.

server {
    listen 80;
    server_name spotterminal.com www.spotterminal.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
