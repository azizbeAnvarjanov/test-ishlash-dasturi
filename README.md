# Easy Testing V10.1 (1.0.1)

Windows lokal tarmog‘ida ishlaydigan ikkita Electron dasturi:

- **Easy Testing Server** — test yaratish, studentlarga bir nechta test yuborish, jonli monitor, studentlar ro‘yxati va batafsil natijalar.
- **Easy Testing Student** — serverga ulanish, studentni aniqlash, testni tanlab yuklash va xavfsiz kiosk rejimida ishlash.

## Yangi imkoniyatlar

- Server va Student GitHub Release orqali yangi versiyani avtomatik tekshiradi, foydalanuvchidan ruxsat olib yuklaydi va o‘rnatadi.
- Student dasturida imtihon davomida update oynasi chiqarilmaydi.
- Server sozlamasida ulanishni **Hammaga ochiq** yoki **Faqat ruxsat berilgan IP’lar** rejimiga o‘tkazish mumkin.
- IP manzillar vergul bilan saqlanadi; ochiq rejimga o‘tilganda ro‘yxat o‘chmaydi va keyin yana yopiq rejimda ishlatiladi.

- Server kompyuterning haqiqiy Wi-Fi/Ethernet IPv4 manzilini avtomatik tanlaydi va **Server IP (LAN)** sifatida ko‘rsatadi; virtual/VPN va `169.254.*` manzillar ustuvor olinmaydi.
- Student server ro‘yxati orqali kirganda F.I.Sh yoki guruh bo‘yicha qidirib, keyin o‘zini tanlashi mumkin.
- Serverning **Sozlamalar → Face ID** bo‘limida JPG/JPEG/PNG rasm tanlab, studentning ismi, familiyasi va guruhini kiritib registratsiya qilish mumkin.
- Face ID ro‘yxatida har bir student uchun **Rasmni o‘chirish** tugmasi mavjud; u profilni va tashqi papkadagi rasm faylini birga o‘chiradi.
- Serverda yaratilgan va Exceldan import qilingan testlar bazada ham, `Documents\Test ishlash dasturi\tests` papkasida alohida `.test.json` fayl sifatida ham avtomatik saqlanadi.
- Testlar sahifasidagi **Testlar papkasini ochish** tugmasi haqiqiy saqlash joyini ko‘rsatadi. Server qayta ochilganda shu lokal fayllardan testlar tiklanadi.
- Excel test importi bo‘sh qatorlar, sarlavha oldidagi qo‘shimcha qatorlar, egri apostroflar va `Variant A` / `Savol matni` kabi muqobil ustun nomlarini qabul qiladi.
- Excelda to‘g‘ri javobni `A-D`, `1-4` yoki variantning to‘liq matni bilan ko‘rsatish mumkin; import qilingan test darhol lokal saqlanadi.
- Har bir test uchun vaqt, studentga tushadigan savollar soni, random/ketma-ket tartib va natijani ko‘rsatish sozlamalari.
- Bir nechta testni studentlarga bir vaqtda yuborish va studentning test tanlashi.
- Student F.I.Sh va guruhni qo‘lda yozishi yoki server ro‘yxatidan tanlashi.
- Boshlagan va tugatgan vaqt, ishlash davomiyligi, kompyuter nomi va har bir javobning to‘g‘ri/noto‘g‘ri holatini serverda saqlash.
- Serverda real vaqt monitori: test, kompyuter, joriy savol va progress.
- Bir studentning bir testni boshqa kompyuterda dubl ishlashini serverda bloklash.
- Test paytida kiosk/fullscreen, oynani yopish va asosiy klavish kombinatsiyalarini bloklash.
- Natijalarni lokal JSON faylda saqlash va tarmoq tiklanganda serverga qayta yuborish.
- Student testni yakunlaganda tasdiqlash oynasi chiqmaydi: natija avtomatik yuboriladi va kiosk/klavisha bloklari darhol o‘chadi.
- Server har ishga tushganda yangi, bo‘sh natijalar sessiyasi boshlanadi; oldingi natijalar joriy ro‘yxatga aralashmaydi.
- **Natijalarni saqlash** orqali joy tanlangandan keyin yangi kelgan natijalar o‘sha faylga avtomatik qo‘shilib boradi.
- Server yopilganda saqlanmagan natija bo‘lsa saqlash yoki saqlamaslik so‘raladi.
- **Natijalar** sahifasidagi **Oldingi natijani ochish** tugmasi saqlangan fayldagi barcha foiz va batafsil javoblarni ko‘rsatadi.
- Studentlar ro‘yxati va test savollarini tayyor Excel shablonlari orqali import qilish mumkin.
- Studentlar ro‘yxatiga Excelning `F.I.Sh` va `Guruh` ustunlarini `Ctrl+C` / `Ctrl+V` bilan to‘g‘ridan-to‘g‘ri qo‘yish ham mumkin.
- Server sozlamasida uchta kirish turi mavjud: qo‘lda yozish, server ro‘yxati va Face ID.
- Face ID rejimida Student dasturi ulangan webcam orqali yuzni skanerlaydi va server bazasidan talabani aniqlaydi.
- Student dasturining boshlang‘ich oynasida kamera sozlamasi va jonli preview bor: ichki kamera yoki USB webcam tanlanadi, tanlov saqlanadi va test paytidagi yuz nazorati ham shu kameradan ishlaydi.
- Tanlangan USB kamera uzilgan bo‘lsa, Student dasturi ichki/default kameraga, so‘ng mavjud boshqa kameralarga avtomatik o‘tadi.
- Yuz nazorati doira markaziga bog‘liq emas: Face Mesh orqali boshning burilishi va ko‘zning yon tomonga qarashi nazorat qilinadi.
- Yon profil 3D yaw xato bergan kameralar uchun burun–ko‘z va burun–yonoq nosimmetriyasi bilan qo‘shimcha aniqlanadi.
- Bazada topilmagan talaba Student dasturidan serverga registratsiya so‘rovi yuboradi.
- Serverning **Monitor** qismida student kompyuteri ko‘rinadi; o‘qituvchi **Skanerlash**ni bosgandagina o‘sha kompyuter kamerasi yuzni olib serverga yuboradi.
- Skanerdan keyin serverda ism, familiya va guruh kiritilib Face ID bazasiga qo‘shiladi; student Face ID orqali qayta skanerlab imtihonga kiradi.
- Face ID ommaviy bazasi ZIP shablon orqali import qilinadi: ZIP ichida `studentlar-face-id.xlsx` va `rasmlar` papkasi bo‘ladi.

## Face ID baza shabloni

1. Serverdagi **Sozlamalar → Face ID → Face ID ZIP shabloni** tugmasini bosing.
2. ZIP ichidagi Excelda `ID`, `F.I.Sh`, `Guruh`, `Rasm fayli` ustunlarini to‘ldiring.
3. Har bir JPG/PNG rasmni Excelda yozilgan nom bilan `rasmlar` papkasiga joylang.
4. Har rasmda bitta, to‘g‘ridan-to‘g‘ri qaragan va yorug‘ yuz bo‘lishi kerak.
5. ZIP faylni **Face ID bazani import qilish** tugmasi orqali yuklang.

> Windows’ning himoyalangan `Ctrl+Alt+Delete` ekranini oddiy Electron dasturi bloklay olmaydi. Qolgan odatiy chiqish kombinatsiyalari va oyna yopilishi test paytida bloklanadi.

## Ishga tushirish

```powershell
npm.cmd install
npm.cmd run dev:server
```

Boshqa terminalda:

```powershell
npm.cmd run dev:student
```

Server `0.0.0.0:4780` portida ishlaydi. Student va server kompyuterlari bitta LAN yoki Wi-Fi tarmog‘ida bo‘lishi kerak.

## Tekshirish va installer

```powershell
npm.cmd run typecheck
npm.cmd run build
npm.cmd run dist:server
npm.cmd run dist:student
```

Installerlar:

- `apps/server/release/Easy-Testing-Server-Setup-1.0.1.exe`
- `apps/student/release/Easy-Testing-Student-Setup-1.0.1.exe`

GitHub release chiqarish tartibi [RELEASING.md](RELEASING.md) faylida yozilgan.

Studentning lokal natijalari `Documents\Test ishlash dasturi\results` papkasida saqlanadi.
Server testlarining ko‘rinadigan lokal nusxalari `Documents\Test ishlash dasturi\tests` papkasida saqlanadi.
