# Pindah ke OpenRouter

Hanya 2 file yang berubah: `gemini-proxy-index.ts` dan `index.html`. Nama function tetap `gemini-proxy`.

## 1. Secret (Supabase > Edge Functions > Secrets)
- Tambah `OPENROUTER_API_KEY_1` (isi key dari https://openrouter.ai/keys). Key tambahan: `_2`, `_3`, dst sampai `_20`.
- Opsional: `OPENROUTER_REFERER` = alamat situs Anda. `ALLOWED_ORIGINS` tetap seperti sebelumnya.
- Secret `GEMINI_API_KEY_*` dan `GEMINI_GROQ_*` tidak dipakai lagi (boleh dihapus).

## 2. Deploy
- Tempel isi `gemini-proxy-index.ts` ke function **gemini-proxy**, lalu Deploy.
- Ganti `index.html` di hosting Anda.

## 3. Model
- ID model sekarang berbentuk `penyedia/model`, mis. `google/gemini-2.5-flash`, `openai/gpt-oss-120b`, `openrouter/auto`.
- Daftar model lama (`gemini-3.8-flash`, dll) di Portal Admin > Model AI otomatis dianggap tidak valid, sehingga daftar bawaan baru dipakai. Buka Portal Admin > Model AI, sesuaikan daftar dengan ID dari https://openrouter.ai/models, tekan **Uji model**, lalu **Simpan**.
- Bila model utama sibuk, OpenRouter otomatis mencoba model lain di daftar (flash dulu).

## Catatan
- Cadangan Groq dihapus (OpenRouter sudah menyediakan fallback model).
- Galat 402 = saldo/kredit OpenRouter pada key itu habis; mode Otomatis pindah ke key berikutnya.
