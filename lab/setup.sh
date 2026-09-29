#!/usr/bin/env bash
#
# setup.sh — build the practice sandbox for "Getting Out of Your Shell"
# Usage:  bash setup.sh        (creates ~/shell-lab and fills it)
#
set -euo pipefail

LAB="${1:-$HOME/shell-lab}"
mkdir -p "$LAB"/{data,logs,conf,scripts,tmp,archive}
cd "$LAB"

# ---------- data ----------
cat > data/sales_2026.csv <<'EOF'
date,region,product,units,revenue
2026-01-04,north,widget,12,240.00
2026-01-11,south,widget,45,900.00
2026-01-18,north,gadget,7,455.00
2026-02-02,east,widget,63,1260.00
2026-02-14,west,gizmo,22,1980.00
2026-02-21,south,gadget,51,3315.00
2026-03-03,north,widget,8,160.00
2026-03-15,east,gizmo,74,6660.00
2026-03-28,west,widget,33,660.00
2026-04-05,south,gizmo,19,1710.00
2026-04-19,north,gadget,58,3770.00
2026-05-02,east,widget,91,1820.00
2026-05-17,west,gadget,27,1755.00
2026-06-01,south,widget,44,880.00
2026-06-20,north,gizmo,66,5940.00
EOF

cat > data/sales_2025.csv <<'EOF'
date,region,product,units,revenue
2025-11-04,north,widget,10,200.00
2025-12-11,south,gadget,25,1625.00
EOF

cat > data/inventory_2026.csv <<'EOF'
sku,product,warehouse,qty
W-100,widget,north,412
G-200,gadget,south,98
Z-300,gizmo,east,37
EOF

cat > data/names.txt <<'EOF'
ada lovelace
grace hopper
ken thompson
dennis ritchie
barbara liskov
EOF

mkdir -p data/tmp data/reports
: > data/scratch.tmp
: > data/reports/old.tmp
printf 'x%.0s' $(seq 1 2048) > data/bigfile.dat
printf 'this file is really a gzip archive, despite its name\n' | gzip -c > data/mystery

# ---------- logs ----------
cat > logs/app.log <<'EOF'
2026-08-13 09:00:01 INFO  app starting, version 2.4.1
2026-08-13 09:00:02 INFO  loading configuration from /etc/myapp/app.conf
2026-08-13 09:00:02 DEBUG cache size set to 256MB
2026-08-13 09:00:03 INFO  connected to database db-01:5432
2026-08-13 09:01:15 WARN  slow query took 2841ms
2026-08-13 09:02:44 INFO  request GET /health 200 3ms
2026-08-13 09:03:12 ERROR connection timeout to payments-api after 5000ms
2026-08-13 09:03:12 DEBUG retry 1 of 3
2026-08-13 09:03:18 ERROR connection timeout to payments-api after 5000ms
2026-08-13 09:03:18 DEBUG retry 2 of 3
2026-08-13 09:03:24 INFO  request POST /orders 201 118ms
2026-08-13 09:05:00 DEBUG cache hit ratio 0.91
2026-08-13 09:07:33 WARN  memory usage at 87%
2026-08-13 09:08:02 INFO  request GET /orders/4821 200 12ms
2026-08-13 09:09:41 ERROR unhandled exception in worker-3
2026-08-13 09:09:41 DEBUG stack trace suppressed
2026-08-13 09:10:00 INFO  worker-3 restarted
2026-08-13 09:12:07 WARN  disk usage at 78%
2026-08-13 09:14:22 INFO  request GET /health 200 2ms
2026-08-13 09:15:58 ERROR failed to write to /var/log/myapp: no space left
2026-08-13 09:16:00 INFO  shutting down gracefully
EOF

cat > logs/access.log <<'EOF'
10.0.0.14 - - [13/Aug/2026:09:00:01] "GET /health HTTP/1.1" 200 12
10.0.0.14 - - [13/Aug/2026:09:00:11] "GET /orders HTTP/1.1" 200 4821
10.0.0.7 - - [13/Aug/2026:09:00:14] "POST /orders HTTP/1.1" 201 88
10.0.0.14 - - [13/Aug/2026:09:00:22] "GET /missing HTTP/1.1" 404 0
192.168.1.55 - - [13/Aug/2026:09:00:31] "GET / HTTP/1.1" 200 1043
10.0.0.7 - - [13/Aug/2026:09:00:44] "GET /orders/1 HTTP/1.1" 200 311
10.0.0.14 - - [13/Aug/2026:09:01:02] "GET /admin HTTP/1.1" 403 0
10.0.0.7 - - [13/Aug/2026:09:01:19] "GET /nope HTTP/1.1" 404 0
10.0.0.14 - - [13/Aug/2026:09:01:33] "GET /health HTTP/1.1" 200 12
192.168.1.55 - - [13/Aug/2026:09:02:04] "GET /static/app.js HTTP/1.1" 200 90211
EOF

: > logs/empty.log

# ---------- conf ----------
cat > conf/nginx.conf <<'EOF'
# main nginx configuration
user www-data;
worker_processes 2;

events {
    worker_connections 1024;
}

http {
    # timeouts
    keepalive_timeout 65;
    send_timeout 30;

    server {
        listen 80;
        server_name example.com;

        location / {
            proxy_pass http://localhost:8080;
            proxy_read_timeout 60;
        }
    }
}
EOF

cat > conf/nginx.conf.new <<'EOF'
# main nginx configuration
user www-data;
worker_processes 4;

events {
    worker_connections 2048;
}

http {
    # timeouts
    keepalive_timeout 65;
    send_timeout 30;

    server {
        listen 443 ssl;
        server_name example.com;

        location / {
            proxy_pass http://localhost:8080;
            proxy_read_timeout 60;
        }
    }
}
EOF

cat > conf/secrets.env <<'EOF'
DB_PASSWORD=hunter2
API_TOKEN=abc123def456
EOF

# ---------- scripts ----------
cat > scripts/backup.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
echo "pretending to back up $(pwd) at $(date +%F)"
EOF

cat > scripts/slow.sh <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
for i in $(seq 1 30); do echo "tick $i"; sleep 1; done
EOF

chmod 644 scripts/*.sh

echo "Sandbox ready at: $LAB"
echo
find "$LAB" -maxdepth 2 | sort | sed "s|$LAB|.|"
