# Anthropic Fallback Proxy

Implementasi dari diskusi: Claude Code hanya diarahkan ke satu endpoint, sementara proxy ini mencoba beberapa `ANTHROPIC_AUTH_TOKEN`/provider secara berurutan saat provider pertama kena kuota, rate-limit, billing/credit error, atau error sementara.

## Fitur

- Fallback multi-provider untuk Claude Code melalui satu `ANTHROPIC_BASE_URL`.
- Normalisasi suffix model Claude Code seperti `claude-opus-4-8[1m]`.
- Header proxy aman untuk mencegah response double-compressed.
- Normalisasi stream untuk gateway Anthropic-compatible yang mengirim `data: [DONE]`.
- Filter blok `thinking`/`thinking_delta` dari gateway yang mengirim format tidak kompatibel.
- Idle timeout untuk mencegah Claude Code infinite spinner saat SSE stream macet.

## Cara pakai

1. Copy contoh env:

```bash
cp .env.example .env
```

2. Isi minimal dua provider di `.env`:

```bash
ANTHROPIC_PROVIDER_1_NAME=qcode-personal
ANTHROPIC_PROVIDER_1_BASE_URL=https://api.anthropic.com
ANTHROPIC_PROVIDER_1_AUTH_TOKEN=sk-ant-xxx

ANTHROPIC_PROVIDER_2_NAME=qcode-work
ANTHROPIC_PROVIDER_2_BASE_URL=https://api.anthropic.com
ANTHROPIC_PROVIDER_2_AUTH_TOKEN=sk-ant-yyy
```

Untuk provider lokal seperti 9router, gunakan `dummy` bila upstream tidak perlu token:

```bash
ANTHROPIC_PROVIDER_3_NAME=9router-for-claude
ANTHROPIC_PROVIDER_3_BASE_URL=http://127.0.0.1:20128
ANTHROPIC_PROVIDER_3_AUTH_TOKEN=dummy
```

3. Jalankan:

```bash
npm start
```

4. Arahkan Claude Code ke proxy:

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:8787
export ANTHROPIC_AUTH_TOKEN=anything
```

Kalau `PROXY_AUTH_TOKEN` di `.env` diisi, gunakan nilai itu sebagai `ANTHROPIC_AUTH_TOKEN`.

## Tanpa file `.env`

Kalau ingin menjalankan langsung tanpa `.env`:

```bash
PORT=8787 \
ANTHROPIC_PROVIDER_1_NAME=qcode-personal \
ANTHROPIC_PROVIDER_1_BASE_URL=https://api.anthropic.com \
ANTHROPIC_PROVIDER_1_AUTH_TOKEN=sk-ant-xxx \
ANTHROPIC_PROVIDER_2_NAME=qcode-work \
ANTHROPIC_PROVIDER_2_BASE_URL=https://api.anthropic.com \
ANTHROPIC_PROVIDER_2_AUTH_TOKEN=sk-ant-yyy \
npm start
```

## Fallback yang ditangani

Proxy akan mencoba provider berikutnya untuk status:

- `402`
- `408`
- `409`
- `425`
- `429`
- `500`
- `502`
- `503`
- `504`
- `529`

Proxy juga melakukan fallback bila body error mengandung indikasi seperti `quota`, `rate limit`, `billing`, `credit`, atau `insufficient`.

## Catatan streaming

Untuk request streaming, fallback aman dilakukan saat upstream mengembalikan error HTTP sebelum stream dimulai. Jika provider sudah mulai mengirim token lalu gagal di tengah stream, proxy tidak bisa mengulang request ke provider lain tanpa berisiko menggandakan output.

## Health check

```bash
curl http://127.0.0.1:8787/health
```

Response berisi daftar provider yang terkonfigurasi.

## Auto-start setelah restart Mac

Setelah `.env` sudah diisi, jalankan sekali:

```bash
chmod +x install-launch-agent.sh uninstall-launch-agent.sh install-claude-env.sh
./install-launch-agent.sh
./install-claude-env.sh
```

Proxy akan otomatis hidup saat login setelah Mac restart.
Claude Code yang dibuka dari terminal baru akan otomatis memakai proxy lokal.

Cek status:

```bash
curl http://127.0.0.1:8787/health
```

Lihat log:

```bash
tail -f proxy.log proxy.err.log
```

Kalau ingin mematikan auto-start:

```bash
./uninstall-launch-agent.sh
```

Jika Claude masih menampilkan `API error`, pastikan proses `claude` yang sedang jalan sudah ditutup dan dibuka ulang. Environment lama tidak berubah untuk proses yang sudah aktif.
