# /etc/nginx/sites-available/juporderbook.com
#
# juporderbook.com goes back to the original Jupiter v1 limit-order viewer (~/workspace/jup-orderbook,
# pm2 "jup-orderbook", port 3006) until the domain expires on 8 April 2027. SpotTerminal moved to
# spotterminal.com.
#
#   sudo cp deploy/nginx-juporderbook.com /etc/nginx/sites-available/juporderbook.com
#   sudo nginx -t && sudo systemctl reload nginx

# www.juporderbook.com -> apex. All four of http/https x www/apex used to answer
# 200 with no canonical, so Google held the home page as "Duplicate without
# user-selected canonical" and indexed none of them.
server {
    listen 80;
    listen 443 ssl;
    server_name www.juporderbook.com;
    ssl_certificate /etc/ssl/cloudflare/origin.crt;
    ssl_certificate_key /etc/ssl/cloudflare/origin.key;
    return 301 https://juporderbook.com$request_uri;
}

server {
    listen 80;
    listen 443 ssl;
    server_name juporderbook.com;

    # Behind Cloudflare the visitor's scheme is in CF-Visitor; keying on it (not
    # $scheme) can't loop whatever the zone's SSL mode is.
    if ($http_cf_visitor ~ '"scheme":"http"') {
        return 301 https://juporderbook.com$request_uri;
    }

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
