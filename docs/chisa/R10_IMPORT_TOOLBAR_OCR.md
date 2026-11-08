# R10 — Impor, OCR, dan workspace

Branch pengembangan `feature/chisa-editor-enhancements`. UI mengikuti gambar referensi yang disediakan pengguna dengan tata letak padat, ikon Lucide, dan tema Sumi & Hikari MangaClean. Bubble Shape tetap di luar scope sesuai keputusan pengguna. Palet yang direncanakan tercatat di [THEME_PLAN.md](./THEME_PLAN.md).

## Perbandingan impor

| Alur | Sebelum | Sesudah | Sampel |
| --- | ---: | ---: | ---: |
| Impor 1 gambar | 0,678 dtk | 0,303 dtk | 3 per versi |
| Impor 14 gambar | 5,958 dtk | 2,951 dtk | 3 per versi |
| Menulis paket saat impor 14 gambar | 3,838 dtk | 1,589 dtk | 3 per versi |
| Membuka chapter tersimpan 14 halaman | 6,659 dtk | 2,350 dtk | 3 per versi |

Angka adalah median di backend, diukur pada salinan gambar manga yang sama dengan cache filesystem yang tidak dikontrol. Waktu membuka chapter diukur pada `Chapter.load`. Dialog pemilihan file dan rendering WebView berada di luar interval.

Impor gambar baru menyimpan PNG asli tanpa pengodean ulang raster bersih yang identik dan menghindari penyalinan paket untuk chapter baru. Append menyiapkan paket terpisah dan memberi ID berbeda pada salinan gambar identik. Membuka chapter tetap memeriksa hash, struktur dan isi tiap paket, lalu memindahkan paket v3/v4 yang lolos validasi tanpa membuat ZIP baru. Tes membandingkan hash isi paket halaman dan memeriksa perlakuan Overlay v4.

## Manga OCR pertama

Uji pembanding CPU meluncurkan worker baru per crop pada bubble 4, 7, dan 9 dari fixture `page_001`. Impor runtime mendominasi percobaan lambat. Impor yang berhasil berkisar 4,36–63,31 detik di dua putaran, dan satu kontrol mencapai timeout 110 detik selama impor. Pada pengamatan lambat yang selesai, tahap impor memakan 50,34 dari 70,01 detik dan 63,31 dari 66,98 detik. Verifikasi SHA serial pada tiga kontrol putaran pertama memakan 0,29–0,37 detik.

Memparalelkan SHA dengan impor runtime menghasilkan hash teks, hasil decode dan model identik pada pasangan yang sama-sama berhasil. Waktu total tidak membaik konsisten antar pasangan. Eksperimen tetap di folder diagnostik. Jalur OCR, pilihan model, dan kualitas input tetap memakai checkpoint R9. Durasi cold-start yang lebih cepat berstatus **Partial**.

## Matriks UI terfokus

| Referensi | Adaptasi |
| --- | --- |
| Startup sederhana | Pilihan file atau folder dari layar kosong |
| Toolbar atas | Import, tool editing, Detect Bubbles, All Pages, OCR/Translate, Process, Clean. Workspace view, navigasi, riwayat, simpan, ekspor, dan Settings di kanan |
| Navigator | Thumbnail ringkas dan penanda halaman aktif. Pilihan antrean dan expand tetap ada |
| Original dan Editing | Judul terpusat, zoom di status bawah, pixel ruler di menu tampilan. Baris konteks tampil saat alat membutuhkan opsi |
| Properties | Translation, Typography, Layers, Healing dan Image memakai kontrol existing. B/I, AA/Aa/aa dan pengaturan Auto Fit dikelompokkan |
| Progress dan Settings | Progress di tengah workspace. Dialog Settings lebih kompak di kanan dengan tab existing |

Artefak benchmark dan pengujian tersimpan di `E:\BagassZx\Yuchi-Diagnostics\chisa-r10-20261107`.

## Verifikasi R10

- **Pass — Native:** `native-r10/MangaClean.exe` berhasil dibuka. Folder fixture berisi 14 gambar diimpor dari dialog Windows. Progress impor muncul di tengah workspace. Tombol Next dan Previous memindahkan kedua kanvas 1 → 2 → 1 dengan urutan halaman yang benar.
- **Pass — Kompatibilitas:** Dua Save native menghasilkan satu chapter berisi 14 paket v3 dan satu chapter dengan satu paket v4 Overlay serta 13 paket v3. Paket lulus verifikasi hash, artwork asli dan raster editing identik dengan fixture untuk kedua salinan. Chapter kedua dibuka kembali dan mode Overlay masih aktif. Bukti ada di `NATIVE_IMPORT_PROOF.json`.
- **Pass — UI:** Settings → Editing menampilkan Clean dan Overlay. Fixture v4 R9 juga dibuka dan Dialogue 01 dipilih. Inspector menampilkan teks sumber OCR, teks Indonesia, font Segoe UI yang tersedia setelah katalog siap, dan kontrol Typography. Screenshot native ada di percakapan. Navigator single-page lama masih menyertakan mini-map dan loupe.
- **Pass — Pemeriksaan kode:** 44 tes backend, 50 tes frontend, typecheck, dan build Windows offline. Pemeriksaan 25 entri hash cocok, termasuk verifikasi terpisah untuk rilis stabil serta chapter aslinya. `main` tetap di `ece3dc84c271288d55976d16a6dcd54307bddc3c`.
- **Pass — Lifecycle:** Normal Close via X keluar dengan kode 0 dan daftar proses milik aplikasi kosong. Satu sesi mencatat sekitar 181 MiB private resident median saat idle dan 412 MiB peak selama sesi. Window terlihat setelah 0,45 detik, sementara health backend tercatat setelah 34,52 detik. Ini satu observasi startup aplikasi dengan cache yang tidak dikontrol. Lihat `session-r10/release-chisa-r10.json`.

Perubahan R10 ada di `backend/chapter_routes.py`, `mangaclean/services/chapter.py`, `mangaclean/services/project_io.py`, `src/App.tsx`, `src/components/StudioShell.tsx`, `src/components/CanvasWorkspace.tsx`, `src/components/Typography.tsx`, `src/design/automation.css`, dan tes terfokus terkait. Rilis R10 merupakan build uji terpisah di folder diagnostik.
