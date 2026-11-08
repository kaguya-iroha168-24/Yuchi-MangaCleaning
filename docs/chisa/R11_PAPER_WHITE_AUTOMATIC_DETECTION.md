# R11 — Paper White, deteksi otomatis, dan Gemini

Build Windows pengembangan menggunakan palet Paper White untuk workspace, kanvas, panel, dan Settings. Crimson Stamp menandai aksi utama, fokus dan notifikasi. Warna sekunder aktif memakai varian Halftone Gray yang lebih gelap untuk keterbacaan. [Rencana tema](./THEME_PLAN.md) mencatat pasangan warna dan rasio kontras. Kotak kandidat memakai latar transparan agar lettering sumber terbaca.

## Kebijakan deteksi

- Settings memilih model detektor. Shima menentukan perangkat secara otomatis saat job dibuat, terlepas dari pilihan CPU atau GPU yang tersimpan dari versi sebelumnya.
- Saat aplikasi dibuka, Windows menjalankan pemeriksaan singkat di latar. Persiapan Shima dijalankan hanya bila tersedia minimal 4 GiB RAM, GPU NVIDIA pertama memiliki minimal 4 GiB VRAM, dan minimal 3 GiB VRAM masih bebas. Detektor memverifikasi runtime dan checkpoint serta menjalankan satu forward. Proses model idle berhenti setelah 60 detik. Penutupan aplikasi membatalkan persiapan yang masih berjalan.
- Ketika scan diminta, CUDA dipakai jika runtime kompatibel dan VRAM mencukupi. CPU menjadi jalur otomatis jika CUDA tidak tersedia, VRAM terlalu rendah, atau CUDA gagal. Thread CPU dibatasi maksimal delapan dan menyisakan satu thread logis bila tersedia. Resolusi, threshold, model, dan region recovery tetap mengikuti pipeline R10.
- Saat halaman sudah punya hasil deteksi, job melewati baca konfigurasi dan hash raster untuk pencarian cache yang tidak dibutuhkan. Pada halaman yang masih memerlukan pemeriksaan cache, hash menggunakan buffer raster tanpa salinan byte.

## Pengukuran pada satu halaman fixture

Semua baris menghasilkan sembilan bubble pada `page_001.png`. Pengukuran diambil dari panggilan deteksi aktual dengan Shima V1 dan RTX 4050 Laptop pada mesin pengembangan. Cache OS dan beban mesin berubah antar-run. Durasi mencakup pipeline backend deteksi dan recovery, di luar dialog file dan rendering GUI.

| Kondisi | Scan pertama | Pengulangan |
| --- | ---: | ---: |
| R10, GPU dan worker baru | 43,97 dtk | 1,09 dtk |
| R11, persiapan dilewati dan scan memilih GPU | 9,67 dtk | 1,73 dan 1,28 dtk |
| R11, scan diminta setelah GPU siap | 1,26 dtk | 1,66 dan 1,26 dtk |
| R11, CUDA disembunyikan untuk uji jalur CPU | 7,91 dtk | 1,46 dtk |

Persiapan GPU yang berhasil tercatat 6,77 detik di latar. Dari scan 1,26 detik setelah persiapan selesai, proses detektor utama memakai 0,46 detik, termasuk inferensi 0,21 detik. Recovery mengambil 0,77 detik. Pemeriksaan checkpoint dan decode input di worker utama masing-masing 0,018 dan 0,042 detik. Besarnya selisih cold-start R10 dan R11 dipengaruhi kondisi mesin, sehingga perbandingan yang relevan untuk perilaku baru adalah biaya setelah persiapan selesai versus sebelum worker siap. Scan yang diminta segera setelah aplikasi dibuka masih bisa menunggu persiapan atau inisialisasi.

## Gemini

Model bawaan `gemini-3.5-flash`, autentikasi `x-goog-api-key`, dan REST `generateContent` sesuai dokumentasi Google. [Model](https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash) · [API](https://ai.google.dev/api)

**Test connection** mengirim satu sampel pendek dan menerapkan key baru setelah respons lolos validasi. Kegagalan tes mempertahankan pengaturan aktif sebelumnya. Key dikirim dalam header HTTPS dan tinggal di memori sesi. Tes mencakup sukses, penolakan, key kosong, respons tanpa rahasia, dan penerapan terjemahan melalui transport simulasi. Endpoint Google menjawab HTTP 403 untuk pemeriksaan HTTPS tanpa key. Keberhasilan dengan akun pengguna memerlukan tes dari Settings memakai key akun tersebut.

## Verifikasi

35 tes backend, 50 tes frontend, TypeScript dan build Windows offline lulus. Pemindaian native menghasilkan sembilan bubble pada halaman uji dengan status selesai dan nol error. Settings native memperlihatkan mode otomatis dan menolak percobaan Test connection dengan kolom key kosong. Build akhir juga membuka fixture v4 dan menampilkan lettering asli serta dialog terjemahan dengan kotak bubble yang transparan.

Pada dua sesi native, jendela terlihat dalam 0,48–0,59 detik dan backend siap dalam 3,96–12,45 detik. Median RAM idle sekitar 168–169 MiB. Puncak sesi dengan inferensi sekitar 1,40 GiB. Kedua sesi ditutup lewat X dengan kode 0 dan tanpa proses aplikasi yang tersisa. Sebanyak 25 entri hash terlindungi cocok.

Artefak pengukuran tersedia di `E:\BagassZx\Yuchi-Diagnostics\chisa-r11-20261108`.
