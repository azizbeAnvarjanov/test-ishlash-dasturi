# GitHub orqali yangi versiya chiqarish

## Bir martalik sozlama

Asosiy repository: `azizbeAnvarjanov/test-ishlash-dasturi`.

Update repository'lari:

- `azizbeAnvarjanov/test-server-updates`
- `azizbeAnvarjanov/test-student-updates`

Har bir update repository mutlaqo bo'sh bo'lmasligi kerak: unda kamida `main` branch va bitta boshlang'ich commit bo'lsin. Aks holda GitHub Release yaratishda `422 Unprocessable Entity` qaytaradi.

GitHub fine-grained token yarating. Token faqat ikki update repository uchun **Contents: Read and write** ruxsatiga ega bo'lsin. Asosiy repository'da `Settings → Secrets and variables → Actions` bo'limiga kirib tokenni `UPDATES_TOKEN` nomi bilan saqlang.

## Birinchi versiya

`1.0.0` updater qo'shilgan ko'prik versiya. Uni Server va barcha Student kompyuterlariga bir marta qo'lda o'rnating. Keyingi versiyalar GitHub'dan avtomatik topiladi.

## Keyingi versiyani chiqarish

1. Root, Server va Student `package.json` versiyalarini bir xil yangi qiymatga almashtiring.
2. `npm install --package-lock-only` bilan lock faylni yangilang.
3. Tekshiring:

   ```powershell
   npm.cmd run typecheck
   npm.cmd run build
   ```

4. Commit va tag yuboring:

   ```powershell
   git add .
   git commit -m "release: 1.0.1"
   git push origin main
   git tag v1.0.1
   git push origin v1.0.1
   ```

Tag push qilinganda GitHub Actions Server va Student NSIS installerlarini quradi va tegishli update repository'ga `latest.yml`, `.exe` va `.blockmap` fayllarini Release sifatida joylaydi. Workflow qayta ishga tushirilsa mavjud release saqlanadi va assetlar `--clobber` orqali yangilanadi.
