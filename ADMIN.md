# Yönetim Panosu — kurulum ve kullanım

Panoya yalnızca **`terminal.finansla.net/admin`** adresinden ulaşılır. Sitenin
hiçbir yerinde bağlantısı veya butonu yoktur, `noindex, nofollow` işaretlidir.

**Giriş: kullanıcı adı yok, şifre yok.** Yalnızca authenticator uygulamanızdaki
6 haneli kod (Google Authenticator, Proton Authenticator, Aegis, 1Password …).

Pano iki aşamada devreye girer, yani kurulumu bitirmeden de dağıtabilirsiniz:

| Yapılan kurulum | Çalışan özellikler |
|---|---|
| Hiçbiri | Sayfa açılır, giriş reddedilir (`ADMIN_TOTP_SECRET tanımlı değil`) |
| `ADMIN_TOTP_SECRET` | Giriş, **sistem sağlığı**, sunucu örneği ve önbellek durumu |
| `+ Upstash değişkenleri` | Yukarıdakiler **+ tüm ziyaretçi analitiği + giriş hız sınırı** |

---

## 1. Authenticator'ı kurun

Üretilen `ADMIN_TOTP_SECRET` değerini (32 karakterlik base32 dizesi) telefonunuza
ekleyin:

- **Google Authenticator** → `+` → *Kurulum anahtarı gir* → Hesap adı:
  `Finansla Terminal`, Anahtar: sır, Tür: **Zaman bazlı**
- **Proton Authenticator / Aegis / 1Password** → *Manuel giriş* → aynı bilgiler

Parametreler standarttır: SHA-1, 6 hane, 30 saniye.

> ⚠️ Bu sır bir şifreye eşdeğerdir. **`ADMIN.md` içine veya repoya yazmayın** —
> bu dosya GitHub'a yükleniyor. Yalnızca telefonunuzda ve Vercel ortam
> değişkenlerinde dursun. Kaybederseniz yenisini üretip değişkeni
> güncellemeniz yeterli.

## 2. Depolamayı oluşturun (5 dakika, ücretsiz)

Vercel fonksiyonları durumsuzdur — disk yok, örnekler arası paylaşılan bellek
yok — bu yüzden sayaçların süreç dışında yaşaması gerekir.

1. **[upstash.com](https://upstash.com)** → ücretsiz kayıt (kart istemez).
2. **Redis** → **Create Database** → plan **Free**, bölge
   **N. Virginia (us-east-1)**.

   > Bölge seçiminde sizin konumunuz değil, **Vercel fonksiyonunun** konumu
   > belirleyicidir — tarayıcı Upstash ile hiç konuşmaz, yalnızca sunucu
   > konuşur. Vercel ücretsiz planda fonksiyonlar `iad1` (Washington DC)
   > bölgesinde çalışır ve plan bölge değiştirmeye izin vermez, bu yüzden
   > `us-east-1` doğru eşleşmedir. Yanlış bölge kritik değildir; arka plandaki
   > bir çağrıya ~100 ms ekler, kullanıcıya yansımaz.

3. Veritabanı sayfasında **REST API** bölümünden şu ikisini kopyalayın:
   `UPSTASH_REDIS_REST_URL` ve `UPSTASH_REDIS_REST_TOKEN`. Token gizlidir,
   yanındaki göz simgesiyle görünür yapın.

   > ⚠️ Aynı sayfadaki `redis://default:...@...:6379` bağlantısı **işe
   > yaramaz** — kodumuz REST API kullanıyor. Kural: **`https://` ile
   > başlıyorsa doğru.**

Ücretsiz katman ayda 500.000 komut. Bir sayfa görüntüleme ~9 komut, yani kabaca
**ayda 55.000 sayfa görüntüleme** sınırı.

## 3. Vercel ortam değişkenleri

Vercel → `risk-engline-terminal-api` projesi → **Settings → Environment
Variables**. Üçünü de *Production* için ekleyin:

| Ad | Değer |
|---|---|
| `ADMIN_TOTP_SECRET` | 1. adımdaki base32 sır |
| `UPSTASH_REDIS_REST_URL` | 2. adımdan |
| `UPSTASH_REDIS_REST_TOKEN` | 2. adımdan |

İsteğe bağlı: `ANALYTICS_SALT` — ziyaretçi karma tuzunun TOTP sırrından bağımsız
olmasını isterseniz. Tanımsızsa `ADMIN_TOTP_SECRET` kullanılır.

> Ortam değişkenleri yalnızca **yeni bir dağıtımda** etkinleşir. Ekledikten
> sonra *Deployments* → en üsttekine **Redeploy**.

## 4. Dosyaları yükleyin

**Backend** — GitHub web arayüzünden yükleyin, Vercel otomatik dağıtır:

```
backend/app/totp.py         (yeni)
backend/app/store.py        (yeni)
backend/app/analytics.py    (yeni)
backend/app/admin.py        (yeni)
backend/app/main.py         (değişti — admin router bağlandı)
```

Yeni pip paketi yok: TOTP tamamen standart kütüphane, Upstash istemcisi düz
`requests` — ikisi de zaten mevcut.

**Frontend** — cPanel dosya yöneticisi, `terminal` alt alan klasörüne:

```
.htaccess                   (yeni — /admin temiz adresi)
admin.html                  (yeni)
js/admin.js                 (yeni)
js/track.js                 (yeni)
js/home.js                  (değişti — tek satır, aramaları bildirir)
css/terminal.css            (değişti — yönetim stilleri eklendi)
index.html  stock.html  fund.html  risk.html
compare.html  screener.html  heatmap.html   (hepsi: ?v=21 + track.js)
```

Tüm sürüm etiketleri **v=21**. Hostinger/LiteSpeed JS/CSS'e 7 günlük
`Cache-Control` gönderdiği için sürüm artırmadan yükleme yaparsanız ziyaretçiler
eski dosyalarda kalır. Yükledikten sonra kendi cihazlarınızda Ctrl+F5.

> `.htaccess` gizli dosyadır. cPanel dosya yöneticisinde **Settings → Show
> Hidden Files** açık olmalı. Sunucuda zaten bir `.htaccess` varsa üzerine
> yazmayın, içeriği mevcut dosyanın sonuna ekleyin.

## 5. Doğrulama

1. `https://terminal.finansla.net/admin` açın — giriş ekranı gelmeli.
2. Authenticator'daki 6 haneli kodu girin. Alan 6 haneye ulaşınca kendiliğinden
   gönderir.
3. **SİSTEM SAĞLIĞI** dört servisi göstermeli. Soğuk başlangıçta ilk sonda yavaş
   olur (Vercel ücretsiz katman boşta uyur) — ısındıktan sonra YENİLE'ye basın.
4. Başka bir sekmede siteyi açın, bir arama yapın, bir hisse sayfasına girin.
5. Panoda **ŞU AN ÇEVRİMİÇİ** ≥ 1 olmalı ve olay 10 saniye içinde **CANLI
   AKIŞ**'ta belirmeli.

Sağlık iyi ama analitik boşsa, SUNUCU ÖRNEĞİ panelinde *Analitik deposu*
`YAPILANDIRILMAMIŞ` yazar — Upstash değişkenleri çalışan dağıtıma ulaşmamış
demektir, yeniden dağıtın.

---

## Panoda ne var

**Özet kutuları** — şu an çevrimiçi (5 dakikalık pencere), bugünün ve seçili
aralığın görüntüleme/tekil ziyaretçi sayıları, toplam görüntüleme.

**Trafik** — 7/14/30/90 günlük günlük görüntüleme, CSS çubuklarıyla çizilir.
Grafik kütüphanesi bilinçli olarak kullanılmadı: bozulabilecek bir CDN daha az.

**Sistem sağlığı** — Yahoo Finance, TEFAS, Google News ve Upstash'e canlı
sondalar, gecikme süreleriyle. Terminalin bağımlı olduğu üç kırılgan kaynak
bunlar; TEFAS veri merkezi IP'lerini kısıtlıyor, Google BUSINESS akışı Vercel'den
503 dönüyor — arıza önce burada görünür.

**Sunucu örneği ve önbellekler** — isteği hangi örnek karşıladı, ne kadardır
ayakta, kaç istek gördü ve bellek içi `history` / `heatmap` / fon evreni
önbelleklerinin durumu. Çalışma süresinin sıfıra yakın olması soğuk başlangıç
demektir.

**Sıralamalar** — en çok aranan, en çok görüntülenen hisse ve fonlar, sayfalar,
ülkeler, yönlendiren siteler.

**Canlı akış** — son 60 olay: ne kadar önce, hangi sayfa, ne arandı/görüntülendi
ve Vercel'in coğrafi başlıklarından şehir/ülke.

## Gizlilik

Ham IP adresleri hiçbir zaman saklanmaz. Ziyaretçi kimliği
`sha256(tuz + ip + tarayıcı)` değerinin ilk 12 karakteridir — tekil kişi saymaya
ve kimin çevrimiçi olduğunu görmeye yeter, geri döndürülemez ve bu veritabanı
dışında işe yaramaz. Tekil sayımlar HyperLogLog kullanır: kimlikleri değil,
yaklaşık bir kardinaliteyi tutar. Çerez yazılmaz, tarayıcıya kimlik konmaz.
Günlük anahtarlar 90 gün sonra silinir.

`track.js` Do Not Track ayarına saygı gösterir. Çok az tarayıcı gönderdiği için
veri kaybı önemsiz; yine de her ziyareti saymak isterseniz dosyanın başındaki
`dnt` bloğunu silin.

Bu haliyle sitenin çerez bandına ihtiyacı yok. İleride tarayıcıya kimlik yazan
bir şey eklerseniz bu değişir.

## Güvenlik notları

- **Bu tek faktörlü bir giriştir.** Şifre istemediğiniz için panoyu koruyan tek
  şey authenticator'daki sır. Telefonunuzu kaybederseniz erişim de gider — sırrı
  bir şifre yöneticisinde yedeklemeniz iyi olur.
- **Hız sınırı bu yüzden kritik.** 6 hane = 1.000.000 olasılık ve kod ~90 saniye
  geçerli; sınırsız deneme hakkı olan biri kaba kuvvetle deneyebilir. IP başına
  15 dakikada 10 hatalı deneme sonrası giriş kilitlenir — **ancak bu Upstash
  yapılandırılmışsa çalışır.** Panoda *Giriş hız sınırı* satırı durumu gösterir;
  `KAPALI` yazıyorsa Upstash'i mutlaka kurun.
- Aynı 6 haneli kod iki kez kullanılamaz (replay koruması, Upstash gerektirir).
- Doğrulama **yalnızca sunucuda** yapılır. Frontend statik ve herkese açık
  olduğu için JS'e konan bir sır herkesçe okunabilirdi.
- `ADMIN_TOTP_SECRET` tanımlı değilse admin uçları **her isteği reddeder**,
  açık kalmaz.
- Oturum jetonu `sessionStorage`'da (yalnızca o sekme, kapanınca silinir) ve
  `X-Admin-Session` başlığıyla gider — URL'ye asla konmaz, çünkü sorgu dizeleri
  sunucu günlüklerine ve tarayıcı geçmişine düşer. Ömrü 8 saat.
- `admin.html` adresinin herkese açık olması sorun değil: API kodu kabul edene
  kadar boş bir kabuktur.

## API uçları

| Uç | Yetki | Açıklama |
|---|---|---|
| `POST /api/track` | açık | `track.js`'ten gelen sayfa görüntüleme sinyali |
| `POST /api/admin/login` | açık | `{"code": "123456"}` → oturum jetonu |
| `GET /api/admin/ping` | oturum | Oturum hâlâ geçerli mi |
| `GET /api/admin/health` | oturum | Servis sondaları, örnek ve önbellek durumu |
| `GET /api/admin/stats?days=14` | oturum | Ziyaretçi ve kullanım analitiği |
| `POST /api/admin/reset` | oturum | Gövde `{"scope": "..."}` — `all`, `queries`, `symbols`, `funds`, `pages`, `geo`, `referrers`, `recent`, `live` |

## Maliyet kontrolü

Pano istatistikleri 10 saniyede, sağlığı 60 saniyede bir yeniler ve **sekme
görünmez olduğunda tamamen durur**. Arka planda açık bırakmak maliyet
oluşturmaz. `OTO` düğmesi yoklamayı büsbütün kapatır.
