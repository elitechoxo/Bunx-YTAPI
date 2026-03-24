FROM oven/bun:1-alpine

# Install required packages
RUN apk add --no-cache \
    python3 \
    py3-pip \
    curl \
    openssh \
    bash

# Install yt-dlp
RUN pip install --no-cache-dir --upgrade yt-dlp[default] --break-system-packages

# Install fxtun
RUN curl -fsSL https://fxtun.dev/install.sh | sh && \
    find / -name "fxtun" -type f 2>/dev/null | head -1 | xargs -I{} ln -sf {} /usr/local/bin/fxtun

ENV PATH="/root/.local/bin:/usr/local/bin:$PATH"

# Configure yt-dlp
RUN mkdir -p /root/.config/yt-dlp && \
    echo '--js-runtimes bun' > /root/.config/yt-dlp/config


# Setup SSH
RUN ssh-keygen -A && \
    mkdir -p /root/.ssh && \
    chmod 700 /root/.ssh

# Add your public key
RUN echo "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHmat6s4EgTzfqWWGx5Takpyv8/D/ejnygc06QFW59hB" >> /root/.ssh/authorized_keys && \
    chmod 600 /root/.ssh/authorized_keys

# Secure SSH config (NO password login)
RUN printf '%s\n' \
    "Port 2222" \
    "PermitRootLogin yes" \
    "PasswordAuthentication no" \
    "PubkeyAuthentication yes" \
    "AuthorizedKeysFile .ssh/authorized_keys" \
    > /etc/ssh/sshd_config

WORKDIR /app
COPY . .

RUN mkdir -p cache

# Startup script
RUN cat > /start.sh << 'EOF'
#!/bin/bash

export PATH="/root/.local/bin:/usr/local/bin:$PATH"

echo "[+] Starting SSH..."
/usr/sbin/sshd

echo "[+] Starting Tunnel..."
fxtun tcp 22 --token sk_fxtunnel_4e12d1fc552853f8f4607dd8084b558ab40f3de0d39caf39 > /tmp/fxtun.log 2>&1 &

sleep 3
echo "[+] Tunnel Info:"
cat /tmp/fxtun.log

echo "[+] Starting Bun App..."
bun run src/index.js
EOF

RUN chmod +x /start.sh

EXPOSE 2222 8000 8080 9000

CMD ["/start.sh"]